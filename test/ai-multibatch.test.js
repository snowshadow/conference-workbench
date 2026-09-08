import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';

const earlyText = '当前方案把“实时”作为前提，但概念含义还没对齐：一方指立即推送，另一方指下一次刷新；我们也还没统一成本假设和上线评价标准。';
const response = payload => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }));
const empty = () => response({ topics: [], followups: [] });

function fixture(t, responder) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-ai-multibatch-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push({ data, body, progress: store.listJobs(data.meetingId)[0].progress });
    return responder(data, { store, calls });
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  return { store, ai, calls };
}

function seedLongMeeting(store) {
  const meeting = store.createMeeting({ title: '早段概念问题、末段无关内容', autoOrganize: false });
  const early = store.appendTranscript(meeting.id, { text: earlyText });
  for (let i = 0; i < 3; i++) store.appendTranscript(meeting.id, { text: '午餐安排。'.repeat(900) });
  store.appendTranscript(meeting.id, { text: '今天设备已经收好，大家准备离开。' });
  return { meeting, early };
}

function topicResult(data) {
  const source = data.sources.find(item => item.text.includes('“实时”'));
  return { topics: source ? [{ id: 'new_scope', title: '实时口径', entries: [{ type: 'question', text: source.text, evidence: [{ id: source.id, quote: source.text }] }] }] : [], followups: [] };
}

function questions(source, count = 1) {
  const texts = ['这里“实时”指立即推送，还是下一次刷新？', '当前成本假设包含多少并发用户？', '上线评价先满足延迟要求，还是交付时间？'];
  return texts.slice(0, count).map(question => ({ kind: 'concept', question, rationale: '原话提出的理解尚未对齐', impact: '影响当前方案的实现范围', evidence: [{ id: source.id, quote: source.text }] }));
}

async function finish(store, submitted) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('Multi-batch fixture did not finish');
}

test('multi-batch organization retrieves early concepts after an unrelated tail and adds at most one question', async t => {
  const { store, ai, calls } = fixture(t, data => {
    if (data.mode === 'organize') {
      const result = topicResult(data);
      const early = data.sources.find(source => source.text === earlyText);
      // Even an unsolicited candidate must not consume the final meeting-wide slot.
      if (early) result.followups = questions(early);
      return response(result);
    }
    const early = data.sources.find(source => source.text === earlyText);
    assert.ok(early, 'the final retrieval must find the issue outside the last topic batch');
    assert.equal(data.knownTopics[0].title, '实时口径');
    assert.ok(data.knownEntries.some(entry => entry.evidenceIds.includes(early.id)));
    return response({ topics: [{ id: 'new_unwanted', title: '澄清阶段不应新增主题', entries: topicResult(data).topics[0].entries }], followups: questions(early, 3) });
  });
  const { meeting, early } = seedLongMeeting(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.data.followupLimit), [0, 0, 1]);
  assert.equal(calls[1].data.sources.some(source => source.id === early.id), false);
  assert.equal(calls[2].data.mode, 'followup');
  assert.match(calls[2].body.messages[0].content, /本次聚焦值得继续追问的问题/);
  assert.deepEqual(calls[2].progress, { phase: 'clarify', completedBatches: 2, totalBatches: 2 });
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.topics.length, 1);
  assert.equal(saved.followups.length, 1);
  assert.deepEqual(saved.followups[0].evidenceIds, [early.id]);
  assert.equal(saved.processedRevision, 5);
  assert.equal(job.result.addedFollowups, 1);
  assert.deepEqual(job.modelCalls.map(call => call.purpose), ['organize', 'organize', 'followup']);
});

test('the final meeting-wide review can remain silent without invalidating organized topics', async t => {
  const { store, ai } = fixture(t, data => data.mode === 'organize' ? response(topicResult(data)) : empty());
  const { meeting } = seedLongMeeting(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done');
  assert.equal(store.getMeeting(meeting.id).topics.length, 1);
  assert.deepEqual(store.getMeeting(meeting.id).followups, []);
  assert.equal(job.result.addedFollowups, 0);
});

for (const citation of ['valid', 'wrong-quote', 'other-meeting']) test(`summary validation uses the full meeting snapshot for omitted old citations: ${citation}`, async t => {
  let early, foreign;
  const { store, ai, calls } = fixture(t, data => {
    if (data.mode !== 'organize') return empty();
    if (data.batch.index === 1) return response({ topics: [{ id: 'new_t', title: '实时口径', summary: '“实时”有两种解释。', summaryEvidence: [{ id: early.id, quote: early.text }], entries: [{type: 'question', text: early.text, evidence: [{id: early.id, quote: early.text}]}] }], followups: [] });
    assert.equal(data.sources.some(source => source.id === early.id), false, 'the old source must actually be outside this prompt window');
    return response({ topics: [{ id: data.knownTopics[0].id, title: '实时口径', summary: '“实时”仍有两种解释；末段只确认设备收尾。', summaryEvidence: [
      { id: citation === 'other-meeting' ? foreign.id : early.id, quote: citation === 'wrong-quote' ? '大家已统一为立即推送。' : early.text },
      { id: data.sources.at(-1).id, quote: data.sources.at(-1).text },
    ], entries: [] }], followups: [] });
  });
  const seeded = seedLongMeeting(store); early = seeded.early;
  const other = store.createMeeting({ title: '另外一场会议' });
  foreign = store.appendTranscript(other.id, { text: early.text });
  const job = await finish(store, ai.submit(seeded.meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 3);
  const topic = store.getMeeting(seeded.meeting.id).topics[0];
  assert.equal(topic.summary, citation === 'valid' ? '“实时”仍有两种解释；末段只确认设备收尾。' : '“实时”有两种解释。');
  if (citation === 'valid') assert.ok(topic.summaryEvidenceIds.includes(early.id));
});

test('failure during the final clarification does not publish a partial topic draft', async t => {
  const { store, ai } = fixture(t, data => data.mode === 'organize' ? response(topicResult(data)) : new Response('{}', { status: 403 }));
  const { meeting } = seedLongMeeting(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'error');
  assert.deepEqual(job.progress, { phase: 'clarify', completedBatches: 2, totalBatches: 2 });
  assert.deepEqual(store.getMeeting(meeting.id).topics, []);
  assert.equal(store.getMeeting(meeting.id).processedRevision, 0);
});

test('host edits during final clarification cancel stale drafts after bounded regeneration', async t => {
  let reviews = 0;
  const { store, ai } = fixture(t, (data, { store }) => {
    assert.deepEqual(store.getMeeting(data.meetingId).topics, [], 'no earlier batch may be published');
    if (data.mode === 'organize') return response(topicResult(data));
    reviews++;
    store.updateMeeting(data.meetingId, { goal: `主持人正在修正目标 ${reviews}` });
    return response({ topics: [], followups: questions(data.sources.find(source => source.text === earlyText)) });
  });
  const { meeting } = seedLongMeeting(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'cancelled');
  assert.equal(reviews, 3);
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.goal, '主持人正在修正目标 3');
  assert.equal(saved.processedRevision, 0);
  assert.deepEqual(saved.topics, []);
  assert.deepEqual(saved.followups, []);
});

test('source correction during final clarification regenerates all batches before saving current evidence', async t => {
  let corrected = false;
  const correctedText = '“实时”概念的范围仍需澄清：当前原话修正为下次刷新与五秒内送达的分歧。';
  const { store, ai, calls } = fixture(t, (data, { store }) => {
    assert.deepEqual(store.getMeeting(data.meetingId).topics, [], 'the superseded topic draft must remain private');
    if (data.mode === 'organize') return response(topicResult(data));
    const source = data.sources.find(item => item.text.includes('“实时”'));
    if (!corrected) { corrected = true; store.editTranscript(data.meetingId, source.id, { text: correctedText }); }
    return response({ topics: [], followups: questions(source) });
  });
  const { meeting, early } = seedLongMeeting(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 6);
  assert.equal(calls[3].data.sourceRevision, 6);
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.processedRevision, 6);
  assert.equal(saved.topics[0].entries[0].text, correctedText);
  assert.equal(saved.followups.length, 1);
  assert.deepEqual(saved.followups[0].evidence, [{ id: early.id, quote: correctedText, revision: 2 }]);
  assert.equal(saved.followups[0].sourceRevision, 6);
});

test('single-batch organization still uses one call and manual followup still allows three', async t => {
  const { store, ai, calls } = fixture(t, data => response({ topics: [], followups: questions(data.sources[0], 3) }));
  const single = store.createMeeting({ title: '单批整理', autoOrganize: false });
  store.appendTranscript(single.id, { text: earlyText });
  assert.equal((await finish(store, ai.submit(single.id, 'organize'))).status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.followupLimit, 1);
  assert.equal(store.getMeeting(single.id).followups.length, 1);

  const manual = store.createMeeting({ title: '手动追问', autoOrganize: false });
  store.appendTranscript(manual.id, { text: earlyText });
  assert.equal((await finish(store, ai.submit(manual.id, 'followup'))).status, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.followupLimit, 3);
  assert.equal(store.getMeeting(manual.id).followups.length, 3);
});
