import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';

function setup(t, reply) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-review-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234', model: 'fixture' } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content); calls.push(data);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(data, store)) } }] }));
  } });
  ai.start(); t.after(async () => { await ai.stop(); store.close(); });
  return { store, ai, calls };
}
async function finish(store, submitted) {
  for (let i = 0; i < 500; i++) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('job timeout');
}
function seed(store) {
  const m = store.createMeeting({ title: '参数验证范围' });
  const q = store.appendTranscript(m.id, { text: '我们这次是否验证参数？', startMs: 0, endMs: 4000 });
  const a = store.appendTranscript(m.id, { text: '本次仅验证函数入口，参数不在范围内。', startMs: 60000, endMs: 65000 });
  store.mutateMeeting(m.id, draft => {
    draft.processedRevision = 2; draft.processedLineCount = 2;
    draft.followups = [{ id: 'f', status: 'active', kind: 'concept', question: q.text, rationale: '验证边界不明', impact: '影响本次验收', evidenceIds: [q.id], evidence: [{ id: q.id, quote: q.text, revision: 1 }], author: 'ai' }];
    draft.focusFollowupId = 'f';
  });
  return { m, q, a };
}

test('minutes rechecks answered questions even when every transcript version was already consumed', async t => {
  const { store, ai, calls } = setup(t, data => {
    assert.equal(data.mode, 'review');
    assert.equal(data.followupLimit, 0);
    assert.deepEqual(data.reviewFollowupIds, ['f']);
    const source = data.sources.find(item => item.text.includes('仅验证'));
    return { topics: [], followups: [], resolvedFollowups: [{ id: 'f', resolution: { outcome: 'clarified', complete: true, text: source.text }, evidence: [{ id: source.id, quote: source.text }] }], focusFollowupId: null };
  });
  const { m } = seed(store);
  const job = await finish(store, ai.submit(m.id, 'minutes'));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 1);
  assert.equal(store.getMeeting(m.id).followups[0].status, 'resolved');
  assert.equal(store.getMeeting(m.id).focusFollowupId, null);
  assert.match(job.result.markdown, /本次仅验证函数入口/);
});

test('partial review progress stays open and is not exported as a completed agreement', async t => {
  const { store, ai } = setup(t, data => ({ topics: [], followups: [], resolvedFollowups: [{ id: 'f', resolution: { outcome: 'needs_verification', complete: false, text: '入口范围已明确，具体测试方式仍待核对。' }, evidence: [{ id: data.sources[1].id, quote: data.sources[1].text }] }], focusFollowupId: 'f' }));
  const { m } = seed(store);
  const job = await finish(store, ai.submit(m.id, 'minutes'));
  assert.equal(job.status, 'done', job.error);
  assert.equal(store.getMeeting(m.id).followups[0].status, 'active');
  assert.match(job.result.markdown, /已有部分进展，问题尚未解决/);
});

test('a host correction during final review prevents the old answer being published', async t => {
  let reviewCount = 0;
  const { store, ai } = setup(t, (data, db) => {
    if (data.mode === 'review') { reviewCount++; db.updateMeeting(data.meetingId, { goal: `主持人修订 ${reviewCount}` }); }
    return { topics: [], followups: [], resolvedFollowups: [{ id: 'f', resolution: { outcome: 'clarified', complete: true, text: '参数不在范围。' }, evidence: [{ id: data.sources[1].id, quote: data.sources[1].text }] }] };
  });
  const { m } = seed(store);
  const job = await finish(store, ai.submit(m.id, 'minutes'));
  assert.equal(job.status, 'cancelled');
  assert.equal(store.getMeeting(m.id).followups[0].status, 'active');
  assert.equal(store.getMeeting(m.id).artifacts.length, 0);
});

test('a completed answer is marked for review when newer speech arrives during final review', async t => {
  const { store, ai } = setup(t, (data, db) => {
    db.appendTranscript(data.meetingId, { text: '补充一下，参数范围刚刚调整了。', startMs: 70000, endMs: 74000 });
    return { topics: [], followups: [], resolvedFollowups: [{ id: 'f', resolution: { outcome: 'clarified', complete: true, text: '本次仅验证入口。' }, evidence: [{ id: data.sources[1].id, quote: data.sources[1].text }] }], focusFollowupId: null };
  });
  const { m } = seed(store);
  const job = await finish(store, ai.submit(m.id, 'minutes'));
  assert.equal(job.status, 'done', job.error);
  const followup = store.getMeeting(m.id).followups[0];
  assert.equal(followup.pendingReview, true);
  assert.equal(followup.resolution.pendingReview, true);
  assert.equal(followup.resolution.sourceRevision, 2);
  assert.equal(store.getMeeting(m.id).transcriptRevision, 3);
});
