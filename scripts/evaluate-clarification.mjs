#!/usr/bin/env node
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { PROMPT_VERSION } from '../server/ai/prompts.js';
import { isActiveFocus, recommendedFocusId } from '../shared/discussion-view.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixturePath = join(root, 'test/fixtures/clarification-cases.json');
export const loadCases = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const writeJSON = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export const sourcesAt = (sources, cutoffMs) => sources.filter(source => source.startMs < cutoffMs && source.endMs <= cutoffMs);

function citations(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'evidence' && Array.isArray(item)) result.push(...item);
    else if (item && typeof item === 'object') citations(item, result);
  }
  return result;
}

export function validateCases(fixture) {
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length);
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, fixture.cases.length);
  for (const item of fixture.cases) {
    assert.ok(['transcript_file', 'meeting_database', 'synthetic'].includes(item.provenance.kind));
    const ids = new Set();
    for (const source of item.sources) {
      assert.ok(source.text?.trim(), `${item.id}: empty source`);
      assert.ok(!ids.has(source.id), `${item.id}: repeated source id`); ids.add(source.id);
      assert.ok(source.startMs >= 0 && source.endMs >= source.startMs, `${item.id}: invalid timing`);
    }
    let previous = -1;
    for (const [index, stage] of item.stages.entries()) {
      assert.ok(stage.cutoffMs > previous, `${item.id}: stages must advance`); previous = stage.cutoffMs;
      const allowed = new Map(sourcesAt(item.sources, stage.cutoffMs).map(source => [source.id, source]));
      assert.ok(allowed.size, `${item.id}/${stage.id}: empty prefix`);
      for (const citation of citations([stage.scriptedReply, ...(index ? [] : item.seedFollowups || [])])) {
        assert.ok(allowed.has(citation.id), `${item.id}/${stage.id}: citation from after cutoff or outside fixture: ${citation.id}`);
        assert.ok(citation.quote && allowed.get(citation.id).text.includes(citation.quote), `${item.id}/${stage.id}: quote changed: ${citation.id}`);
      }
    }
  }
  return fixture;
}

// Full-prefix mode is optional because it can turn each case into many model
// calls. End times delimit complete text turns, not real audio alignment.
export function transcriptPrefix(path, cutoffMs) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const headers = lines.flatMap((text, index) => {
    const match = text.trim().match(/^(.+?)\s+(\d{2}):(\d{2}):(\d{2})$/);
    return match ? [{ index, speakerId: match[1], startMs: (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000 }] : [];
  });
  return headers.flatMap((header, index) => {
    const next = headers[index + 1];
    // A turn without a known ending is not included in an earlier prefix.
    const endMs = next?.startMs ?? Number.POSITIVE_INFINITY;
    if (header.startMs >= cutoffMs || endMs > cutoffMs) return [];
    const text = lines.slice(header.index + 1, next?.index).join('\n').trim();
    return text ? [{ id: `kickoff-L${header.index + 1}`, text, speakerId: header.speakerId, startMs: header.startMs, endMs }] : [];
  });
}

function liveSettings(settingsFile) {
  // Never instantiate the production Store: its constructor repairs live state.
  const database = new DatabaseSync(resolve(settingsFile), { readOnly: true });
  let saved;
  try { saved = JSON.parse(database.prepare('SELECT data FROM settings WHERE id=1').get()?.data || '{}').llm || {}; }
  finally { database.close(); }
  const llm = { baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com', model: process.env.LLM_MODEL || 'deepseek-chat', apiKey: process.env.LLM_API_KEY || '', ...saved };
  for (const [field, variable] of Object.entries({ baseUrl: 'EVAL_LLM_BASE_URL', model: 'EVAL_LLM_MODEL', apiKey: 'EVAL_LLM_API_KEY', reasoningEffort: 'EVAL_LLM_REASONING_EFFORT' })) {
    if (process.env[variable] !== undefined) llm[field] = process.env[variable];
  }
  return llm;
}

async function finish(store, submitted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await sleep(50);
  }
  throw new Error(`Evaluation job timed out after ${timeoutMs} ms`);
}

function inspectOutcome(meeting, expected) {
  const active = meeting.followups.filter(isActiveFocus);
  const focusId = recommendedFocusId(meeting);
  const tracked = meeting.followups.find(item => item.id === expected.trackedId);
  const focus = active.find(item => item.id === focusId);
  const checks = [], observations = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  if (expected.focus === 'explanation') {
    check('主屏有当前焦点', focus);
    check('解释已通过 reducer 保存，且能关联原话', focus?.clarification?.explanation && !focus.clarification.stale && focus.clarification.evidenceIds?.length);
    if (expected.minimumMeanings) observations.push(`预期辨清至少 ${expected.minimumMeanings} 种含义；结构化列出 ${focus?.clarification?.distinctions?.length || 0} 项。是否在正文中讲清由人工评审，不以数组长度代替语义质量。`);
  }
  if (expected.focus === 'quiet') { check('没有继续推荐主屏焦点', focusId === null); check('其他问题列表也不留此类当前焦点', active.length === 0); }
  if (expected.tracked === 'resolved_or_retired') check('原疑问已解决或退出当前焦点', tracked && !isActiveFocus(tracked) && (tracked.status === 'resolved' || tracked.attention?.needed === false));
  if (expected.tracked === 'retired_not_resolved') {
    check('残余问题退出焦点但没有虚构全部解决', tracked?.status === 'active' && tracked.attention?.needed === false && tracked.resolution?.complete !== true);
    check('退出原因保留了原话依据', tracked?.attention?.reason && tracked.attention?.evidenceIds?.length);
  }
  return { checks, observations, passed: checks.every(item => item.passed), focusId, activeCount: active.length, followups: meeting.followups };
}

/** Local evaluation only. A separate Store per case prevents any writes to real meetings. */
export async function runEvaluation({ fixture = loadCases(), caseIds, live = false, fullPrefix = false, settingsFile = join(root, 'data/workbench.sqlite'), outRoot = join(root, 'test-output/clarification-evaluations'), timeoutMs = 20 * 60 * 1000, onProgress = () => {} } = {}) {
  validateCases(fixture);
  const selected = fixture.cases.filter(item => !caseIds?.length || caseIds.includes(item.id));
  assert.ok(selected.length, 'No matching cases');
  for (const id of caseIds || []) assert.ok(selected.some(item => item.id === id), `Unknown case: ${id}`);
  const llm = live ? liveSettings(settingsFile) : { baseUrl: 'http://127.0.0.1:1', model: 'offline-scripted-reply', apiKey: '' };
  const outDir = join(resolve(outRoot), `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = { mode: live ? 'live' : 'offline-scripted', promptVersion: PROMPT_VERSION, model: llm.model, reasoningEffort: llm.reasoningEffort || 'default', qualityVerdict: 'requires_human_review', fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), outDir, cases: [] };
  for (const item of selected) {
    const caseDir = join(outDir, item.id); mkdirSync(caseDir, { mode: 0o700 });
    const store = new Store(join(caseDir, 'isolated-store'));
    // Keep credentials only in memory: no production settings copied to disk.
    store.getSettings = () => ({ llm });
    const meeting = store.createMeeting({ title: `回放测试 · ${item.title}`, goal: '帮助参会者看清当前讨论中真正需要澄清的概念和前提。' });
    store.updateMeeting(meeting.id, { autoOrganize: false, status: 'active' });
    let stage, allowed;
    const calls = [];
    const ai = createAIService({ store, fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
      for (const source of data.sources || []) assert.ok(allowed.has(source.id), `Future/out-of-scope source in request: ${source.id}`);
      assert.equal(Object.hasOwn(data, 'expected'), false);
      assert.equal(Object.hasOwn(data, 'scriptedReply'), false);
      const call = { stage: stage.id, request: body, startedAt: new Date().toISOString() };
      calls.push(call); onProgress({ caseId: item.id, stageId: stage.id, request: calls.length, sourceCount: data.sources?.length || 0 });
      const response = live ? await globalThis.fetch(url, request) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(stage.scriptedReply) } }] }), { headers: { 'Content-Type': 'application/json' } });
      // Do not copy request headers or provider error bodies into artifacts.
      call.httpStatus = response.status;
      if (response.ok) call.response = await response.clone().json();
      call.finishedAt = new Date().toISOString();
      return response;
    } });
    const result = { id: item.id, title: item.title, provenance: item.provenance, stages: [] };
    try {
      ai.start();
      const inserted = new Set();
      for (const [index, nextStage] of item.stages.entries()) {
        stage = nextStage;
        const sources = fullPrefix && item.provenance.kind === 'transcript_file' ? transcriptPrefix(item.provenance.localPath, stage.cutoffMs) : sourcesAt(item.sources, stage.cutoffMs);
        allowed = new Set(sources.map(source => source.id));
        for (const source of sources) if (!inserted.has(source.id)) {
          store.appendTranscript(meeting.id, { id: source.id, text: source.text, speakerId: source.speakerId, startMs: source.startMs, endMs: source.endMs, origin: 'asr' }); inserted.add(source.id);
        }
        if (index === 0 && item.seedFollowups?.length) store.mutateMeeting(meeting.id, draft => {
          draft.followups = structuredClone(item.seedFollowups).map(followup => ({ ...followup, sourceRevision: 0, stale: false, pendingReview: false, evidence: followup.evidence.map(evidence => ({ ...evidence, revision: 1 })), createdAt: new Date().toISOString() }));
          draft.focusFollowupId = draft.followups[0].id;
        });
        const callStart = calls.length;
        const job = await finish(store, ai.submit(meeting.id, 'organize'), timeoutMs);
        const outcome = inspectOutcome(store.getMeeting(meeting.id), stage.expected);
        if (job.status !== 'done') { outcome.checks.unshift({ name: '分析任务完成', passed: false }); outcome.passed = false; }
        const recorded = { id: stage.id, cutoff: stage.cutoff, cutoffMs: stage.cutoffMs, coverage: fullPrefix && item.provenance.kind === 'transcript_file' ? 'full_prefix' : item.provenance.coverage, sourceCount: sources.length, requestCount: calls.length - callStart, job, expected: stage.expected, ...outcome };
        result.stages.push(recorded);
        writeJSON(join(caseDir, `${stage.id}.sources.json`), sources);
        writeJSON(join(caseDir, `${stage.id}.result.json`), recorded);
        writeJSON(join(caseDir, 'model-calls.json'), calls);
        if (job.status !== 'done') break;
      }
    } finally { await ai.stop(); store.close(); }
    report.cases.push(result);
    writeJSON(join(outDir, 'report.json'), report);
  }
  report.structuralPassed = report.cases.every(item => item.stages.every(stage => stage.passed));
  writeJSON(join(outDir, 'report.json'), report);
  const md = ['# 澄清解释回放评审', '', `模式：${report.mode} · 模型：${report.model} · 提示词：${PROMPT_VERSION}`, '', live ? '这是实际模型输出；结构检查不能替代语义评审。' : '这是预设回复的管线检查，未发送模型请求，不能据此宣称提示词效果通过。', '', '| 案例 | 截止 | 原文范围 | 请求数 | 结构检查 | 语义评分 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const item of report.cases) for (const stage of item.stages) md.push(`| ${item.title} | ${stage.cutoff} | ${stage.coverage} · ${stage.sourceCount} 段 | ${stage.requestCount} | ${stage.passed ? '通过' : '未通过'} | 待人工核对 |`);
  md.push('', '评分建议：解释是否真正说清、是否忠实于截止时的证据、是否值得当前关注、是否承接已得到的答案，各 0–2 分。0=未做到，1=部分做到，2=达到；这些分数不由关键词命中代替。', '');
  for (const item of report.cases) for (const stage of item.stages) {
    md.push(`## ${item.title} · ${stage.cutoff}`, '', ...stage.checks.map(check => `- [${check.passed ? 'x' : ' '}] ${check.name}`), '', ...stage.observations, '', '人工核对：', '', ...(stage.expected.quality || []).map(text => `- [ ] ${text}`), ...(stage.expected.failures || []).map(text => `- [ ] 没有出现：${text}`), '');
    for (const followup of stage.followups) {
      md.push(`### ${followup.question}`, '', `状态：${followup.status}；当前关注：${isActiveFocus(followup) ? '是' : '否'}`, '');
      if (followup.clarification) md.push(followup.clarification.explanation, '', ...(followup.clarification.distinctions || []).map(part => `- **${part.title}**：${part.text}`), '');
      if (followup.resolution) md.push(`记录：${followup.resolution.text}`, '');
      if (followup.attention?.reason) md.push(`退出原因：${followup.attention.reason}`, '');
    }
  }
  writeFileSync(join(outDir, 'review.md'), `${md.join('\n')}\n`, { mode: 0o600 });
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {}, caseIds = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--full-prefix') options.fullPrefix = true;
    else if (arg === '--case') caseIds.push(args[++index]);
    else if (arg === '--settings') options.settingsFile = args[++index];
    else if (arg === '--out') options.outRoot = args[++index];
    else if (arg === '--list') { for (const item of loadCases().cases) console.log(`${item.id}\t${item.title}`); return; }
    else if (arg === '--help') { console.log('node scripts/evaluate-clarification.mjs [--live] [--case ID] [--full-prefix] [--settings data/workbench.sqlite] [--out DIR]\n默认仅跑预设回复的本地管线验证；--live 才调用已配置模型。可用 EVAL_LLM_MODEL 等环境变量临时覆盖，不修改会议配置。'); return; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (caseIds.length) options.caseIds = caseIds;
  options.onProgress = ({ caseId, stageId, request, sourceCount }) => console.log(`${caseId}/${stageId} · request ${request} · ${sourceCount} sources`);
  const report = await runEvaluation(options);
  console.log(`${report.mode}: structural checks ${report.structuralPassed ? 'passed' : 'failed'}; semantic quality requires human review.\n${join(report.outDir, 'review.md')}`);
  if (!report.structuralPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
