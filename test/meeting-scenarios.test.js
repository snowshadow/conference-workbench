import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { awaitingSpeakers, meetingScenario } from '../shared/meeting-scenarios.js';
import { isReadingFocus } from '../shared/discussion-view.js';

const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(store, job) {
  for (let i = 0; i < 1000; i++) {
    const saved = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(saved.status)) return saved;
    await pause(3);
  }
  assert.fail('Analysis did not finish');
}
function fixture(t, options = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-scenarios-'))), calls = [];
  store.saveSettings({ llm: { baseUrl: 'http://localhost:1234/v1', model: 'fixture' } });
  const ai = createAIService({ store, ...options, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push({ url, headers: request.headers, body, data });
    if (options.respond) return options.respond(data, body);
    const source = data.sources?.[0];
    return response({ topics: source && data.mode !== 'retrospective_focus' ? [{ id: data.knownTopics?.[0]?.id || 'new_t', title: '接口联调', summary: '周五交付接口。', summaryEvidence: [{ id: source.id }], entries: [{ type: 'action', text: '周五交付接口，等待验收标准确认。', due: '周五', evidence: [{ id: source.id }] }] }] : [], followups: [] });
  } });
  ai.start(); t.after(async () => { await ai.stop(); store.close(); });
  return { store, ai, calls };
}
function imported(store, scenario = 'regular') {
  const meeting = store.createMeeting({ title: '场景验收', scenario });
  store.updateMeeting(meeting.id, { source: 'recording_import', status: 'ended', autoOrganize: false });
  store.mutateMeeting(meeting.id, m => { m.speakersConfirmedAt = null; });
  const line = store.appendTranscript(meeting.id, { text: '周五交付接口，验收标准还要和客户端确认。', speakerId: 'speaker-1', startMs: 0, endMs: 5000 });
  return { meeting, line };
}

test('offline analysis waits across restart; naming speakers makes no model calls; confirmation is idempotent', async t => {
  const { store, ai, calls } = fixture(t);
  const { meeting, line } = imported(store);
  for (const type of ['minutes', 'organize', 'followup', 'answer']) assert.throws(() => ai.submit(meeting.id, type, { question: '总结' }), /先确认说话人/);
  store.updateParticipant(meeting.id, line.participantId, { name: '陈工' });
  assert.equal(ai.refreshSpeakers(meeting.id, [line.id]), null);
  await ai.stop(); ai.start();
  assert.equal(awaitingSpeakers(store.getMeeting(meeting.id)), true);
  assert.equal(calls.length, 0);
  const job = ai.confirmSpeakers(meeting.id);
  assert.equal(ai.confirmSpeakers(meeting.id).id, job.id);
  assert.equal(ai.submit(meeting.id, 'minutes').id, job.id);
  const done = await finished(store, job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.participants[0].displayName, '陈工');
  assert.equal(ai.confirmSpeakers(meeting.id).id, job.id);
  assert.equal((await finished(store, ai.submit(meeting.id, 'minutes'))).status, 'done');
  assert.equal(calls.length, 1, 'repeat export reuses analysis');
  const markdown = store.getMeeting(meeting.id).artifacts[0].markdown;
  assert.match(markdown, /## TODO[\s\S]*## 潜在分歧与待对齐事项[\s\S]*## 已明确的决定/);
  assert.match(markdown, /负责人：待明确/);
  assert.doesNotMatch(markdown, /## 复盘焦点|## 讨论要点/);
});

test('confirmation refuses incomplete imports and missing model settings without clearing the gate', async t => {
  const { store, ai, calls } = fixture(t);
  const { meeting } = imported(store);
  const importing = store.createJob(meeting.id, 'import');
  store.updateMeeting(meeting.id, { importJobId: importing.id });
  assert.throws(() => ai.confirmSpeakers(meeting.id), /转录完成/);
  store.updateJob(importing.id, { status: 'error' });
  assert.throws(() => ai.confirmSpeakers(meeting.id), /转录完成/);
  store.updateJob(importing.id, { status: 'done' });
  store.saveSettings({ llm: { baseUrl: 'https://example.invalid', apiKey: '' } });
  assert.throws(() => ai.confirmSpeakers(meeting.id), /配置 AI/);
  assert.equal(awaitingSpeakers(store.getMeeting(meeting.id)), true);
  assert.equal(calls.length, 0);
});

test('technical meetings retain two-stage focus review and lead the minutes with focuses; scene changes invalidate reuse', async t => {
  const { store, ai, calls } = fixture(t);
  const { meeting } = imported(store, 'technical');
  assert.equal((await finished(store, ai.confirmSpeakers(meeting.id))).status, 'done');
  assert.deepEqual(calls.map(c => c.data.mode), ['retrospective_topics', 'retrospective_focus']);
  let current = store.getMeeting(meeting.id);
  assert.ok(current.artifacts[0].markdown.indexOf('## 复盘焦点') < current.artifacts[0].markdown.indexOf('## 决定'));
  store.updateMeeting(meeting.id, { scenario: 'regular' });
  current = store.getMeeting(meeting.id);
  assert.equal(current.artifacts[0].stale, true);
  assert.equal(current.processedRevision, 0);
  assert.equal(current.retrospectiveAnalysis, undefined);
  assert.equal((await finished(store, ai.submit(meeting.id, 'minutes'))).status, 'done');
  assert.equal(calls.length, 3);
  assert.match(calls[2].body.messages[0].content, /本场是例会/);
});

test('regular analysis saves unresolved coordination gaps in the same pass as TODO', async t => {
  const { store, ai, calls } = fixture(t, { respond: data => {
    const evidence = [{ id: data.sources[0].id }];
    return response({ topics: [], followups: [{ id: 'new_f', kind: 'criteria', retrospective: true, question: '交付验收标准是否已经对齐？', rationale: '需要和客户端核对验收范围。', impact: '影响周五交付。', evidence, clarification: { explanation: '需要核对双方所指的验收标准，不把交付日期当成已确认验收范围。', evidence } }] });
  } });
  const { meeting } = imported(store);
  const job = await finished(store, ai.confirmSpeakers(meeting.id));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 1);
  const current = store.getMeeting(meeting.id);
  assert.equal(current.followups.length, 1);
  assert.equal(isReadingFocus(current.followups[0], current), true);
  assert.match(current.artifacts[0].markdown, /交付验收标准是否已经对齐/);
  assert.equal(isReadingFocus({ ...current.followups[0], resolution: { complete: true } }, current), false);
});

test('OpenCode receives a stable meeting session, and custom providers receive no OpenCode header', async t => {
  const { store, ai, calls } = fixture(t);
  store.saveSettings({ llm: { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', apiKey: 'fixture' } });
  const { meeting } = imported(store, 'technical');
  assert.equal((await finished(store, ai.confirmSpeakers(meeting.id))).status, 'done');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(call.body.model, 'deepseek-v4.1-flash');
    assert.equal(call.headers['x-opencode-session'], `meeting-${meeting.id}`);
    assert.match(call.headers['User-Agent'], /^conference-workbench\//);
  }
  store.saveSettings({ llm: { baseUrl: 'http://localhost:1234/v1' } });
  await finished(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(calls.at(-1).headers['x-opencode-session'], undefined);
});

test('new meetings default to regular; historical meetings keep technical behavior; invalid scenes are rejected', t => {
  const { store } = fixture(t);
  assert.equal(store.createMeeting({ title: '例会' }).scenario, 'regular');
  assert.equal(meetingScenario({ title: '旧会议' }), 'technical');
  assert.throws(() => store.createMeeting({ title: 'invalid', scenario: 'other' }), /会议场景/);
  const meeting = store.createMeeting({ title: '技术会', scenario: 'technical' });
  assert.throws(() => store.updateMeeting(meeting.id, { scenario: 'other' }), /会议场景/);
  assert.equal(store.getMeeting(meeting.id).scenario, 'technical');
});

test('long regular imports cover every source before synthesis without a second focus pass', async t => {
  const { store, ai, calls } = fixture(t, { retrospectiveMaxChars: 4200, respond: data => {
    const source = data.sources?.[0];
    return response({ topics: source ? [{ id: `new_${source.id}`, title: '交付', summary: '周五交付。', summaryEvidence: [{ id: source.id }], entries: [] }] : data.coveredSections.flatMap(section => section.topics), followups: [] });
  } });
  const { meeting } = imported(store);
  for (let i = 0; i < 12; i++) store.appendTranscript(meeting.id, { text: `第${i + 1}项。${'保留这段完整发言，周五交付。'.repeat(40)}`, startMs: i * 5000 + 6000 });
  const job = await finished(store, ai.confirmSpeakers(meeting.id));
  assert.equal(job.status, 'done', job.error);
  const extracts = calls.filter(c => c.data.mode === 'retrospective_extract');
  assert.ok(extracts.length > 1);
  const covered = extracts.flatMap(c => c.data.sources.map(source => source.id));
  assert.equal(covered.length, 13);
  assert.equal(new Set(covered).size, 13);
  assert.equal(calls.at(-1).data.coverage.complete, true);
  assert.equal(calls.some(c => c.data.mode === 'retrospective_focus'), false);
  assert.equal(store.getMeeting(meeting.id).processedRevision, 13);
});
