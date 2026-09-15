import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';

const privateText = 'sk-fixture-private-key PRIVATE_MEETING_PROMPT';
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [], followups: [] }) } }] }));
const failure = (status, error) => new Response(JSON.stringify({ error }), { status });

async function run(t, responder) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-ai-errors-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', apiKey: privateText } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return responder(calls.length, body);
  } });
  t.after(async () => { await ai.stop(); store.close(); });
  ai.start();
  const meeting = store.createMeeting({ title: '错误分类测试', autoOrganize: false });
  store.appendTranscript(meeting.id, { text: '需要先确认当前方案的上线范围。' });
  const submitted = ai.submit(meeting.id, 'organize');
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return { job, calls, meeting: store.getMeeting(meeting.id) };
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('AI error fixture did not finish');
}

test('model configuration failures stop after one request and keep the source watermark', async t => {
  const cases = [
    { status: 400, error: { message: `The supported API model names are deepseek-v4-pro, deepseek-v4-flash, and deepseek-v4-flash-vision-exp, but you passed deepseek-4-flash. ${privateText}` } },
    { status: 404, error: { code: 'model_not_found', message: privateText } },
    { status: 400, error: { type: 'invalid_request_error', param: 'model', message: privateText } },
  ];
  for (const entry of cases) await t.test(`${entry.status} ${entry.error.code || entry.error.param || 'provider message'}`, async t => {
    const { job, calls, meeting } = await run(t, () => failure(entry.status, entry.error));
    assert.equal(job.status, 'error');
    assert.match(job.error, /模型名称无效或不可用/);
    assert.match(job.error, new RegExp(`HTTP ${entry.status}`));
    assert.doesNotMatch(job.error, /sk-fixture|PRIVATE_MEETING|deepseek/);
    assert.equal(calls.length, 1);
    assert.equal(meeting.processedRevision, 0);
    assert.equal(meeting.topics.length, 0);
  });
});

test('authentication and exhausted quota are actionable failures without retry or raw error disclosure', async t => {
  const cases = [
    { status: 401, error: { message: privateText }, expected: /鉴权失败/ },
    { status: 403, error: { message: privateText }, expected: /访问权限/ },
    { status: 400, error: { code: 'invalid_api_key', message: privateText }, expected: /鉴权失败/ },
    { status: 402, error: { message: privateText }, expected: /余额或可用额度不足/ },
    { status: 429, error: { code: 'insufficient_quota', message: privateText }, expected: /余额或可用额度不足/ },
    { status: 429, error: { message: `You exceeded your current quota. ${privateText}` }, expected: /余额或可用额度不足/ },
  ];
  for (const entry of cases) await t.test(`${entry.status} ${entry.error.code || entry.expected}`, async t => {
    const { job, calls } = await run(t, () => failure(entry.status, entry.error));
    assert.equal(job.status, 'error');
    assert.match(job.error, entry.expected);
    assert.doesNotMatch(job.error, /sk-fixture|PRIVATE_MEETING/);
    assert.equal(calls.length, 1);
  });
});

test('unsupported response_format retries once without the parameter, including HTTP 422', async t => {
  const { job, calls } = await run(t, count => count === 1
    ? failure(422, { code: 'unsupported_parameter', param: 'response_format', message: `This model does not support response_format. ${privateText}` })
    : success());
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.equal(calls[1].response_format, undefined);
});

test('a persistent explicit format failure stops after the compatibility fallback', async t => {
  const { job, calls } = await run(t, () => failure(400, { code: 'unsupported_response_format', message: privateText }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /不支持当前的输出格式/);
  assert.doesNotMatch(job.error, /sk-fixture|PRIVATE_MEETING/);
  assert.equal(calls.length, 2);
});

test('unknown HTTP 400 keeps the existing JSON compatibility fallback', async t => {
  const { job, calls } = await run(t, count => count === 1 ? new Response(`legacy server ${privateText}`, { status: 400 }) : success());
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].response_format, undefined);
});

test('temporary rate limits retain retry and the requested JSON format', async t => {
  const { job, calls } = await run(t, count => count === 1
    ? failure(429, { code: 'rate_limit_exceeded', message: `Too many requests. ${privateText}` }) : success());
  assert.equal(job.status, 'done');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].response_format, { type: 'json_object' });
});

test('an oversized provider body is cancelled after bounded reading and never displayed', async t => {
  let pulls = 0, cancelled = false;
  const { job, calls } = await run(t, () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode(privateText.padEnd(16384, 'x'))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 401 }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /鉴权失败/);
  assert.doesNotMatch(job.error, /sk-fixture|PRIVATE_MEETING/);
  assert.equal(calls.length, 1);
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
});
