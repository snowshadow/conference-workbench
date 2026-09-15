#!/usr/bin/env node
// An isolated, fictional meeting for README screenshots and a first look.
// Do not load .env or reuse WORKBENCH_DATA_DIR in this process.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../server/app.js';
import { Store } from '../server/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('请先运行 npm run build。');
const port = Number(process.env.DEMO_PORT || 8798);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DEMO_PORT 必须在 1024–65535 之间。');
for (const key of Object.keys(process.env)) {
  if (/^(LLM_|VOLCENGINE_ASR_|FILE_ASR_|OMLX_|VOICEPRINT_)/.test(key)) delete process.env[key];
}
const dataDir = mkdtempSync(join(tmpdir(), 'conference-workbench-demo-'));
const store = new Store(dataDir);
const meeting = store.createMeeting({ title: '社区读书会 · 活动方案讨论（虚构演示）', goal: '确定首场活动的报名范围、资料准备与验收方式。所有内容均为人工编写的演示数据。' });
store.updateMeeting(meeting.id, { autoOrganize: false, source: 'recording_import', status: 'ended' });
const speech = [
  ['林舟', '首场读书会先开放二十个名额，我们要先确认活动流程能跑通。'],
  ['小禾', '报名表应该保持稳定，志愿者已经按当前栏目准备了说明。'],
  ['阿远', '但参加者换了联系电话，我们总得允许更新，否则当天联系不上。'],
  ['小禾', '我说的稳定是栏目不变，姓名和联系电话里的内容可以按参加者确认的信息修正。'],
  ['林舟', '那我们决定：首场沿用现有栏目，允许参加者更新联系方式。'],
  ['阿远', '我会在周五前补上报名确认页，并检查手机上的填写流程。'],
  ['小禾', '活动资料的文字版已经整理好了，音频版还没有试过。'],
  ['林舟', '本次先验收文字版，音频版留到下一场，不影响这次活动安排。'],
  ['阿远', '二十个名额如果同时提交，我们还没有测过，需要在开放报名前补一次检查。'],
  ['小禾', '我来准备活动说明和反馈问卷，周五一起核对。'],
];
const lines = speech.map(([speakerId, text], i) => store.appendTranscript(meeting.id, { speakerId, text, startMs: i * 30000, endMs: i * 30000 + 24000, origin: 'host' }));
store.updateMeeting(meeting.id, { speakerLabels: Object.fromEntries(speech.map(([name]) => [name, name])) });
const evidence = (...indices) => indices.map(i => ({ id: lines[i].id, quote: lines[i].text, revision: 1 }));
const entry = (id, type, text, indices, extra = {}) => ({ id, type, text, status: 'active', author: 'ai', sourceRevision: lines.length, evidence: evidence(...indices), evidenceIds: indices.map(i => lines[i].id), ...extra });
store.mutateMeeting(meeting.id, m => {
  m.processedRevision = m.transcriptRevision;
  m.processedThroughMs = lines.at(-1).endMs;
  m.topics = [
    { id: 'scope', title: '首场活动范围', summary: '开放二十个名额，先验证报名与现场活动的完整流程。', parentId: null, entries: [entry('scope-decision', 'decision', '首场开放二十个名额，以跑通活动流程为目标。', [0])] },
    { id: 'signup', title: '报名表与信息更新', summary: '栏目保持不变；参加者确认后的联系方式可以更新。', parentId: 'scope', entries: [entry('signup-decision', 'decision', '沿用现有栏目，允许更新联系方式。', [3, 4]), entry('signup-action', 'action', '补齐报名确认页，检查手机填写流程。', [5], { owner: '阿远', due: '周五前' })] },
    { id: 'materials', title: '活动资料', summary: '本次验收文字版，音频版留待下一场。', parentId: 'scope', entries: [entry('materials-decision', 'decision', '本次只验收文字版资料。', [6, 7]), entry('materials-action', 'action', '准备活动说明和反馈问卷。', [9], { owner: '小禾', due: '周五' })] },
    { id: 'verification', title: '开放前的验证', summary: '同时提交报名尚未测试，开放前需要补查。', parentId: 'scope', entries: [entry('verification-question', 'question', '二十人同时报名时，提交是否正常？', [8])] },
  ];
  m.followups = [
    { id: 'stable', topicId: 'signup', kind: 'concept', question: '报名表要「稳定」，联系方式还能更新吗？', rationale: '同一个「稳定」，说的是栏目结构和填写内容两件事。', impact: '', status: 'resolved', retrospective: true, author: 'ai', sourceRevision: m.transcriptRevision, evidence: evidence(1, 2, 3), evidenceIds: [1, 2, 3].map(i => lines[i].id), priority: { level: 'high', reason: '这个误解影响报名规则，会上已经说清，值得保留。' }, clarification: { explanation: '栏目保持约定，让志愿者沿用同一套说明；联系方式跟随参加者确认的信息更新。把结构与内容分开，就能同时满足这两个要求。', distinctions: [{ title: '稳定的栏目', text: '姓名、联系电话等栏目沿用既定方案。' }, { title: '可更新的内容', text: '参加者确认了新号码，就修正这一栏的值。' }] }, resolution: { outcome: 'clarified', complete: true, text: '首场沿用现有栏目，允许参加者更新联系方式。', author: 'ai', sourceRevision: m.transcriptRevision, evidenceIds: [lines[4].id] } },
    { id: 'capacity', topicId: 'verification', kind: 'assumption', question: '二十个名额，是否意味着同时报名也已验证？', rationale: '活动规模已经确定，同时提交的表现还没有验证。', status: 'active', retrospective: true, author: 'ai', sourceRevision: m.transcriptRevision, evidence: evidence(0, 8), evidenceIds: [lines[0].id, lines[8].id], priority: { level: 'medium', reason: '开放报名前需要补上验证。' }, clarification: { explanation: '名额是活动容量，提交是否成功是系统表现。确定二十个名额，并不能代替二十人同时操作时的检查。' } },
  ];
  m.focusFollowupId = 'stable';
});
store.saveArtifact(meeting.id, 'minutes', { author: 'host', sourceRevision: lines.length, markdown: '# 社区读书会 · 活动方案讨论\n\n> 虚构演示；以下内容为人工编写，不代表模型实测结果。\n\n## 已明确的决定\n\n- 首场开放二十个名额，先跑通活动流程。\n- 报名表栏目不变，联系方式可以更新。\n- 本次验收文字版资料，音频版留到下一场。\n\n## 行动项\n\n| 事项 | 负责人 | 时间 |\n| --- | --- | --- |\n| 补齐报名确认页，检查手机填写流程 | 阿远 | 周五前 |\n| 准备活动说明和反馈问卷 | 小禾 | 周五 |\n\n## 尚未验证\n\n二十人同时提交报名是否正常，开放前需要补查。\n\n## 值得记住的澄清\n\n「报名表稳定」指栏目保持约定，填写内容仍可按确认后的事实修正。\n' });
store.close();
const workbench = createWorkbench({ dataDir });
workbench.server.on('error', async error => { console.error(error.message); await workbench.close(); process.exitCode = 1; });
workbench.server.listen(port, '127.0.0.1', () => {
  console.log(`虚构演示 http://127.0.0.1:${port}/?meeting=${meeting.id}`);
  console.log('内容为预置样例；无录音，不调用模型，不读取正式数据或 .env。');
  console.log(`独立临时数据：${dataDir}`);
  console.log('按 Ctrl+C 退出。正式使用请运行 npm start。');
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await workbench.close(); });
