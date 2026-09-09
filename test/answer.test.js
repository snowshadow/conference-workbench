import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { answerBatches, answerCandidates, evidenceFor, sourceView } from '../server/ai/retrieval.js';

const reply = content => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const grounded = (sources, answer = '两种安排需要核对适用范围。') => ({ answer, inference: '', evidence: sources.map(({ id, text }) => ({ id, quote: text })), insufficient: false });

test('punctuation-only citations cannot ground an answer through empty normalized text', () => {
  const source = { id: 'original', text: '先准备试点，再决定是否上线。', revision: 1 };
  const byId = new Map([[source.id, source]]);
  for (const quote of ['。。', '？！', '— —', ' ✨ ✨ ', '（）']) {
    assert.equal(evidenceFor({ evidence: [{ id: source.id, quote }] }, byId), null, quote);
  }
  assert.deepEqual(evidenceFor({ evidence: [{ id: source.id, quote: '先准备试点，再决定是否上线。' }] }, byId), [{ id: source.id, quote: source.text, revision: 1 }]);
});

function fixture(t, respond) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-answer-test-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture', reasoningEffort: 'low' } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push({ body, data });
    return respond(data, { store, calls, body, request });
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  const meeting = store.createMeeting({ title: '问答回归' });
  return { store, ai, calls, meeting };
}

async function finish(store, job) {
  const until = Date.now() + 7000;
  while (Date.now() < until) {
    const current = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('问答任务未完成');
}

test('short questions receive the complete original scope without word matching or truncation', async t => {
  const { store, ai, meeting, calls } = fixture(t, data => reply(grounded(data.sources)));
  const first = store.appendTranscript(meeting.id, { text: '首批需要尽早发布。', speakerId: 'a' });
  const second = store.appendTranscript(meeting.id, { text: '只要效果还不达标，就延后两周。', speakerId: 'b' });
  const result = await finish(store, ai.submit(meeting.id, 'answer', { question: '有哪两个观点是有些冲突的？' }));
  assert.equal(result.status, 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data.sources.map(line => line.id), [first.id, second.id]);
  assert.equal(result.result.coverage.strategy, 'full_scope');
  assert.equal(result.result.coverage.complete, true);
  assert.equal(result.result.insufficient, false);
  assert.ok(calls.every(call => call.body.reasoning_effort === 'low'));
});

test('long questions inspect every batch and combine distant viewpoints with at most two selectors', async t => {
  let active = 0, peak = 0;
  const inspected = new Set();
  const { store, ai, meeting, calls } = fixture(t, async data => {
    if (data.batch) {
      active++; peak = Math.max(peak, active);
      for (const line of data.sources) inspected.add(line.id);
      await new Promise(resolve => setTimeout(resolve, data.batch.index === 1 ? 25 : 5));
      active--;
      return reply({ sourceIds: data.sources.filter(line => /尽早发布|延后两周/.test(line.text)).map(line => line.id) });
    }
    assert.equal(active, 0, 'synthesis waits for every selector');
    assert.equal(data.sources.length, 2);
    return reply(grounded(data.sources));
  });
  const early = store.appendTranscript(meeting.id, { text: '产品建议先尽早发布，改进放到上线后。', startMs: 0 });
  for (let i = 0; i < 140; i++) store.appendTranscript(meeting.id, { text: `第 ${i} 项进度。${'普通接口联调与埋点进展。'.repeat(70)}`, startMs: (i + 1) * 1000 });
  const late = store.appendTranscript(meeting.id, { text: '质量不到标准就延后两周，不能靠上线后补救。', startMs: 200000 });
  const result = await finish(store, ai.submit(meeting.id, 'answer', { question: '两位的看法有什么不同？' }));
  assert.equal(result.status, 'done');
  assert.equal(peak, 2);
  assert.equal(inspected.size, 142);
  assert.deepEqual(result.result.evidenceIds, [early.id, late.id]);
  const coverage = result.result.coverage;
  assert.equal(coverage.strategy, 'semantic_batches');
  assert.equal(coverage.reviewedLines, 142);
  assert.equal(coverage.selectedLines, 2);
  assert.equal(coverage.omittedCandidateLines, 0);
  assert.deepEqual(coverage.selectedSourceIds, [early.id, late.id]);
  assert.equal(coverage.batches.flatMap(batch => batch.sources).length, 142);
  assert.ok(coverage.batches.every(batch => batch.sources.every(source => Object.keys(source).sort().join(',') === 'id,revision')));
  assert.ok(!JSON.stringify(coverage).includes('不能靠上线后补救'));
  assert.equal(result.modelCalls.filter(call => call.purpose === 'answer_select').length, coverage.batches.length);
  assert.equal(result.modelCalls.at(-1).purpose, 'answer');
  assert.ok(calls.every(call => call.body.reasoning_effort === 'low'));
});

test('source batch budget includes serialized metadata and retains long utterance tails', () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({ id: `long-id-${i}`, text: `前文${'中'.repeat(3000)}结尾${i}`, speakerId: 's', origin: 'asr', revision: 1, startMs: i }));
  const labels = { s: '姓名'.repeat(50) };
  const batches = answerBatches(sources, 8000, labels);
  assert.deepEqual(batches.flat(), sources);
  for (const batch of batches) assert.ok(JSON.stringify(sourceView(batch, labels)).length <= 8000);
  assert.ok(batches.flat().at(-1).text.endsWith('结尾19'));
});

test('bounded final candidates give each batch a turn rather than taking the oldest prefix', () => {
  const make = (id, startMs) => ({ id, text: '证据'.repeat(80), startMs, revision: 1 });
  const batches = [[make('early-a', 0), make('early-b', 1), make('early-c', 2)], [make('late', 100)]];
  const selected = answerCandidates(batches, [['early-a', 'early-b', 'early-c'], ['late']], 600);
  assert.ok(selected.some(line => line.id === 'early-a'));
  assert.ok(selected.some(line => line.id === 'late'));
});

test('topic scope includes child and summary evidence but excludes unrelated original and AI context', async t => {
  const { store, ai, meeting, calls } = fixture(t, data => reply(grounded(data.sources)));
  const a = store.appendTranscript(meeting.id, { text: '上线要先完成试点。' });
  const b = store.appendTranscript(meeting.id, { text: '子议题补充试点必须覆盖手机。' });
  const c = store.appendTranscript(meeting.id, { text: '总结关联的原文。' });
  const outside = store.appendTranscript(meeting.id, { text: '不在本次问题范围的原文。' });
  store.mutateMeeting(meeting.id, current => {
    current.topics = [
      { id: 'parent', title: '范围', summaryEvidenceIds: [c.id], entries: [{ id: 'a', evidenceIds: [a.id], text: a.text }] },
      { id: 'child', parentId: 'parent', title: '子议题', entries: [{ id: 'b', evidenceIds: [b.id], text: b.text }] },
      { id: 'other', title: '外部议题', entries: [{ id: 'outside', evidenceIds: [outside.id], text: '不应泄漏的其他议题总结' }] },
    ];
    current.followups = [{ id: 'outside-q', topicId: 'other', question: '不应进入限定范围的问题', evidenceIds: [outside.id] }];
  });
  const result = await finish(store, ai.submit(meeting.id, 'answer', { question: '有哪些安排？', topicId: 'parent' }));
  assert.equal(result.status, 'done');
  assert.deepEqual(calls[0].data.sources.map(source => source.id), [a.id, b.id, c.id]);
  assert.deepEqual(calls[0].data.knownTopics.map(topic => topic.id), ['parent', 'child']);
  assert.deepEqual(calls[0].data.existingFollowups, []);
  assert.ok(!JSON.stringify(calls[0].data).includes('不应泄漏'));
  assert.equal(result.result.coverage.scope, 'topic');
});

test('genuine insufficient answers keep the explanation rather than a generic fallback', async t => {
  const { store, ai, meeting } = fixture(t, () => reply({ answer: '这段讨论只有试点安排，尚不能比较两种上线主张。', inference: '', evidence: [], insufficient: true }));
  store.appendTranscript(meeting.id, { text: '我们先准备试点。' });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '双方有何分歧？' }));
  assert.equal(job.status, 'done');
  assert.equal(job.result.reason, 'insufficient_evidence');
  assert.equal(job.result.answer, '这段讨论只有试点安排，尚不能比较两种上线主张。');
});

test('bad citations get one repair and only the grounded repair is published', async t => {
  const { store, ai, meeting, calls } = fixture(t, (data, { calls }) => reply(calls.length === 1
    ? { answer: '尚未决定', evidence: [{ id: data.sources[0].id, quote: '不存在的引文' }] }
    : grounded(data.sources, '会议仍在准备试点。')));
  store.appendTranscript(meeting.id, { text: '我们先准备试点。' });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '定了什么？' }));
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 2);
  assert.equal(store.getMeeting(meeting.id).questions.length, 1);
  assert.equal(job.result.answer, '会议仍在准备试点。');
});

test('missing, foreign and nonverbatim citations fail visibly after one repair', async t => {
  for (const mode of ['empty', 'foreign', 'quote']) await t.test(mode, async t => {
    const { store, ai, meeting, calls } = fixture(t, data => reply({ answer: '已决定上线。', insufficient: false, evidence: mode === 'empty' ? [] : [{ id: mode === 'foreign' ? 'foreign-id' : data.sources[0].id, quote: mode === 'quote' ? '会议没有说过的原话' : data.sources[0].text }] }));
    store.appendTranscript(meeting.id, { text: '需要先准备试点。' });
    const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '定了什么？' }));
    assert.equal(job.status, 'error');
    assert.match(job.error, /原文引用未能核对/);
    assert.equal(calls.length, 2);
    assert.equal(store.getMeeting(meeting.id).questions.length, 0);
  });
});

test('a failed selection batch cannot publish partial coverage as an insufficient answer', async t => {
  let active = 0;
  const { store, ai, meeting } = fixture(t, async data => {
    assert.ok(data.batch);
    active++;
    await new Promise(resolve => setTimeout(resolve, data.batch.index === 1 ? 15 : 30));
    active--;
    return data.batch.index === 1 ? new Response('{}', { status: 403 }) : reply({ sourceIds: [] });
  });
  for (let i = 0; i < 10; i++) store.appendTranscript(meeting.id, { text: '正常讨论。'.repeat(1000) });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '有哪些观点？' }));
  assert.equal(job.status, 'error');
  assert.equal(active, 0, 'workers settle before the job completes');
  assert.equal(job.coverage.complete, false);
  assert.equal(store.getMeeting(meeting.id).questions.length, 0);
});

test('empty scoped sources explain the missing input and do not call a model', async t => {
  const { store, ai, meeting, calls } = fixture(t, () => assert.fail('No model call expected'));
  store.appendTranscript(meeting.id, { text: '其他议题原文。' });
  store.mutateMeeting(meeting.id, current => { current.topics = [{ id: 'empty', title: '无来源主题', entries: [] }]; });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '这里说了什么？', topicId: 'empty' }));
  assert.equal(job.status, 'done');
  assert.equal(job.result.reason, 'no_topic_sources');
  assert.match(job.result.answer, /没有关联的原文/);
  assert.equal(calls.length, 0);
});

test('empty semantic selections record complete inspection without fabricating a model answer', async t => {
  const { store, ai, meeting, calls } = fixture(t, data => { assert.ok(data.batch); return reply({ sourceIds: [] }); });
  for (let i = 0; i < 10; i++) store.appendTranscript(meeting.id, { text: '接口已经联调。'.repeat(1000) });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '招了几个人？' }));
  assert.equal(job.status, 'done');
  assert.equal(job.result.reason, 'no_relevant_sources');
  assert.equal(job.result.coverage.reviewedLines, 10);
  assert.equal(job.result.coverage.selectedLines, 0);
  assert.equal(job.result.coverage.complete, true);
  assert.equal(calls.length, job.result.coverage.batches.length);
});

test('a fabricated selection ID is repaired once then fails without an answer', async t => {
  const { store, ai, meeting } = fixture(t, data => { assert.ok(data.batch); return reply({ sourceIds: ['other-meeting-source'] }); });
  for (let i = 0; i < 10; i++) store.appendTranscript(meeting.id, { text: '接口已经联调。'.repeat(1000) });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '有什么安排？' }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /未能核对回答所需的原文来源/);
  assert.equal(store.getMeeting(meeting.id).questions.length, 0);
  assert.ok(job.modelCalls.every(call => call.purpose === 'answer_select'));
});

test('source edits during parallel selection discard the snapshot before synthesis', async t => {
  let edited = false;
  const { store, ai, meeting, calls } = fixture(t, (data, { store }) => {
    if (data.batch) {
      if (!edited) { edited = true; store.editTranscript(data.meetingId, data.sources[0].id, { text: '更正后：先完成试点。' }); }
      return reply({ sourceIds: data.sources.filter(line => line.text.startsWith('更正后')).map(line => line.id) });
    }
    return reply(grounded(data.sources));
  });
  for (let i = 0; i < 10; i++) store.appendTranscript(meeting.id, { text: '普通事项的讨论内容。'.repeat(1000) });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '目前怎么安排？' }));
  assert.equal(job.status, 'done');
  const synthesis = calls.filter(call => !call.data.batch);
  assert.equal(synthesis.length, 1);
  assert.equal(synthesis[0].data.sources[0].text, '更正后：先完成试点。');
  assert.equal(job.result.sourceRevision, 11);
  assert.equal(job.result.coverage.sourceRevision, 11);
  assert.equal(job.result.coverage.reviewedLines, 10);
  assert.equal(store.getMeeting(meeting.id).questions.length, 1);
});

test('new speech during an answer keeps the original question snapshot and coverage', async t => {
  const { store, ai, meeting } = fixture(t, (data, { store }) => {
    store.appendTranscript(data.meetingId, { text: '新增发言只供下次回答。' });
    return reply(grounded(data.sources));
  });
  store.appendTranscript(meeting.id, { text: '初始安排是准备试点。' });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '目前有什么安排？' }));
  assert.equal(job.status, 'done');
  assert.equal(job.result.sourceRevision, 1);
  assert.equal(job.result.coverage.scopedLines, 1);
  assert.equal(job.result.coverage.reviewedLines, 1);
  assert.equal(store.getMeeting(meeting.id).transcriptRevision, 2);
});

test('empty generated text is an error rather than insufficient evidence', async t => {
  const { store, ai, meeting } = fixture(t, () => reply({ answer: ' ', insufficient: true, evidence: [] }));
  store.appendTranscript(meeting.id, { text: '准备试点。' });
  const job = await finish(store, ai.submit(meeting.id, 'answer', { question: '怎么安排？' }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /没有生成回答/);
  assert.ok(job.modelCalls.every(call => call.validation === 'empty_answer'));
  assert.equal(store.getMeeting(meeting.id).questions.length, 0);
});
