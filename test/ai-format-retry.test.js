import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';

const secret = 'fixture-format-retry-key';
const rawMarker = 'PRIVATE_INVALID_PROVIDER_RESPONSE';
const response = content => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
const invalidContract = () => response({ topics: [], followups: [], resolvedFollowups: [{ id: 'focus', resolution: { outcome: 'clarified', text: rawMarker }, evidence: [] }] });
const validContract = data => {
  const source = data.sources[0];
  return response({ topics: [], followups: [], resolvedFollowups: [{ id: 'focus', resolution: { outcome: 'clarified', text: source.text, complete: false }, evidence: [{ id: source.id, quote: source.text }] }], focusFollowupId: 'focus' });
};

async function run(t, responder) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-format-retry-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', apiKey: secret } });
  const requests = [];
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return responder(requests.length, JSON.parse(body.messages[1].content));
  } });
  t.after(async () => { await ai.stop(); store.close(); });
  const meeting = store.createMeeting({ title: '格式重试核验', autoOrganize: false });
  const source = store.appendTranscript(meeting.id, { text: '范围已确定，负责人还需要核对。' });
  store.mutateMeeting(meeting.id, draft => {
    draft.followups = [{ id: 'focus', question: '范围和负责人确定了吗？', status: 'active', author: 'ai', evidenceIds: [source.id], evidence: [{ id: source.id, quote: source.text, revision: source.revision }], sourceRevision: 1 }];
    draft.focusFollowupId = 'focus';
  });
  const before = store.getMeeting(meeting.id);
  ai.start();
  const submitted = ai.submit(meeting.id, 'organize');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return { job, requests, before, after: store.getMeeting(meeting.id) };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('format retry fixture did not complete');
}

test('one invalid successful response can recover without weakening the output contract', async t => {
  for (const [label, invalid] of [
    ['invalid content JSON', () => response(`{"broken":"${rawMarker}`)],
    ['missing resolution.complete', invalidContract],
    ['invalid provider JSON', () => new Response(`broken ${rawMarker}`)],
  ]) await t.test(label, async t => {
    const { job, requests, after } = await run(t, (count, data) => count === 1 ? invalid() : validContract(data));
    assert.equal(job.status, 'done', job.error);
    assert.equal(requests.length, 2);
    assert.equal(job.modelCalls.length, 1);
    assert.equal(job.modelCalls[0].formatRetries, 1);
    assert.equal(after.processedRevision, 1);
    assert.equal(after.followups[0].status, 'active', 'explicit complete=false stays a partial answer');
    assert.equal(after.followups[0].resolution.complete, false);
    assert.match(requests[1].messages[0].content, /上次输出未通过格式校验/);
    assert.match(requests[1].messages[0].content, /resolution\.complete.*布尔值/);
    assert.equal(requests[1].messages[1].content, requests[0].messages[1].content);
    assert.equal(JSON.stringify(requests[1]).includes(rawMarker), false, 'bad provider text is not fed back to the model');
    assert.equal(JSON.stringify(job).includes(rawMarker), false);
    assert.equal(JSON.stringify(job).includes(secret), false);
  });
});

test('persistent malformed output retries once and leaves meeting content untouched', async t => {
  for (const [label, invalid] of [
    ['invalid JSON', () => response(`not JSON ${rawMarker}`)],
    ['missing completion flag', invalidContract],
  ]) await t.test(label, async t => {
    const { job, requests, before, after } = await run(t, invalid);
    assert.equal(job.status, 'error');
    assert.match(job.error, /JSON|格式无效/);
    assert.equal(requests.length, 2);
    assert.equal(job.modelCalls[0].formatRetries, 1);
    assert.deepEqual(after, before, 'a failed batch never advances the watermark or writes partial content');
    assert.equal(JSON.stringify(job).includes(rawMarker), false);
    assert.equal(JSON.stringify(job).includes(secret), false);
  });
});

test('format recovery shares the three-attempt limit with temporary HTTP failures', async t => {
  const { job, requests } = await run(t, (count, data) => count === 1
    ? Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 })
    : count === 2 ? invalidContract() : validContract(data));
  assert.equal(job.status, 'done', job.error);
  assert.equal(requests.length, 3);
  assert.equal(job.modelCalls[0].formatRetries, 1);
});

test('an exhausted network budget does not gain an extra format attempt', async t => {
  const { job, requests, before, after } = await run(t, count => count < 3
    ? Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 })
    : invalidContract());
  assert.equal(job.status, 'error');
  assert.equal(requests.length, 3);
  assert.equal(job.modelCalls[0].formatRetries, undefined);
  assert.deepEqual(after, before);
});
