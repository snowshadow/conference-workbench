import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribeVolcStandardAudio } from '../server/import/volcengine-standard.js';

const config = { apiKey: 'speech-fixture-secret', resourceId: 'volc.seedasr.auc' };
const tos = { region: 'cn-beijing', bucket: 'fixture-bucket', accessKeyId: 'storage-fixture-id', accessKeySecret: 'storage-fixture-secret' };
const payload = { audio_info: { duration: 1500 }, result: { text: '会议结束。', utterances: [{ text: '会议结束。', start_time: 100, end_time: 1400, additions: { speaker: '2' } }] } };
const reply = (code = '20000000', body = payload, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'X-Api-Status-Code': code } });
function fixture() {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asr-standard-')), '000000.cloud.json');
  return { stateFile, state: () => JSON.parse(fs.readFileSync(stateFile)), call: options => transcribeVolcStandardAudio({ audio: Buffer.from('fixture-wave'), config, tos, stateFile, pollIntervalMs: 1, ...options }) };
}

test('uploads, submits a URL, polls both pending states and persists timestamps before cleanup', async () => {
  const f = fixture(), calls = [], progress = []; let requestId, queries = 0;
  const result = await f.call({ onProgress: phase => progress.push(phase), fetchImpl: async (url, req) => {
    calls.push(req.method === 'POST' ? url.split('/').at(-1) : req.method);
    assert.equal(req.redirect, 'error');
    if (req.method === 'PUT') { assert.ok(f.state().requestId); return new Response(); }
    if (req.method === 'DELETE') { assert.equal(f.state().result.text, '会议结束。'); return new Response(); }
    assert.equal(req.headers['X-Api-Key'], config.apiKey);
    assert.equal(req.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
    requestId ||= req.headers['X-Api-Request-Id'];
    assert.equal(req.headers['X-Api-Request-Id'], requestId);
    if (url.endsWith('/submit')) {
      const body = JSON.parse(req.body);
      assert.equal(body.audio.data, undefined);
      assert.equal(new URL(body.audio.url).hostname, 'fixture-bucket.tos-cn-beijing.volces.com');
      assert.equal(body.request.ssd_version, '300');
      assert.equal(body.request.enable_speaker_info, true);
      return reply();
    }
    assert.deepEqual(JSON.parse(req.body), {});
    return reply(['20000002', '20000001', '20000000'][queries++]);
  } });
  assert.deepEqual(calls, ['PUT', 'submit', 'query', 'query', 'query', 'DELETE']);
  assert.equal(progress[0], 'uploading');
  assert.deepEqual(result.segments, [{ text: '会议结束。', start: 0.1, end: 1.4, speaker_id: '2' }]);
  assert.equal(f.state().cleaned, true);
  assert.doesNotMatch(fs.readFileSync(f.stateFile, 'utf8'), /speech-fixture-secret|storage-fixture|X-Tos-Signature|https:/);
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
});

test('lost submit response is recovered by querying its saved ID without another upload or submission', async () => {
  const f = fixture(); let originalId;
  await assert.rejects(f.call({ fetchImpl: async (url, req) => {
    if (req.method === 'PUT') return new Response();
    originalId = req.headers['X-Api-Request-Id'];
    throw new Error(`network error ${config.apiKey}`);
  } }), /无法连接/);
  assert.equal(f.state().submitted, undefined);
  const calls = [];
  const result = await f.call({ fetchImpl: async (url, req) => {
    calls.push(req.method === 'POST' ? 'query' : req.method);
    if (req.method === 'DELETE') return new Response();
    assert.ok(url.endsWith('/query'));
    assert.equal(req.headers['X-Api-Request-Id'], originalId);
    return reply();
  } });
  assert.equal(result.text, '会议结束。');
  assert.deepEqual(calls, ['query', 'DELETE']);
});

test('shutdown leaves the submitted task available for resume with its original resource and bucket', async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(f.call({ signal: controller.signal, fetchImpl: async (url, req) => {
    if (req.method === 'PUT') return new Response();
    if (url.endsWith('/submit')) return reply();
    controller.abort(); return reply('20000001');
  } }), error => error.name === 'AbortError');
  const id = f.state().requestId;
  await f.call({ config: { ...config, resourceId: 'volc.bigasr.auc' }, tos: { ...tos, region: 'cn-shanghai', bucket: 'different-bucket' }, fetchImpl: async (url, req) => {
    if (req.method === 'DELETE') { assert.match(url, /fixture-bucket.tos-cn-beijing/); return new Response(); }
    assert.ok(url.endsWith('/query'));
    assert.equal(req.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
    assert.equal(req.headers['X-Api-Request-Id'], id);
    return reply();
  } });
});

test('cleanup failure keeps a completed transcript and cached retry only retries cleanup', async () => {
  const f = fixture();
  const result = await f.call({ fetchImpl: async (url, req) => req.method === 'DELETE' ? new Response('secret', { status: 403 }) : req.method === 'PUT' ? new Response() : reply() });
  assert.equal(result.text, '会议结束。'); assert.match(result.cleanupWarning, /清理失败/);
  assert.equal(f.state().cleanupPending, true);
  const cached = await f.call({ fetchImpl: async (_url, req) => { assert.equal(req.method, 'DELETE'); return new Response(); } });
  assert.equal(cached.text, result.text); assert.equal(cached.cleanupWarning, undefined);
});

test('a rejected bucket can be corrected without retrying the old bucket forever', async () => {
  const f = fixture();
  await assert.rejects(f.call({ fetchImpl: async () => new Response(null, { status: 404 }) }), /存储桶/);
  assert.equal(f.state().cleaned, true);
  const oldId = f.state().requestId;
  await f.call({ tos: { ...tos, bucket: 'corrected-bucket' }, fetchImpl: async (url, req) => {
    if (req.method !== 'POST') { assert.match(url, /corrected-bucket/); return new Response(); }
    assert.notEqual(req.headers['X-Api-Request-Id'], oldId); return reply();
  } });
});

test('silence succeeds and terminal submit rejection cleans up without exposing provider content', async () => {
  for (const rejected of [false, true]) {
    const f = fixture(); let removed = false;
    const pending = f.call({ fetchImpl: async (url, req) => {
      if (req.method === 'DELETE') { removed = true; return new Response(); }
      if (req.method === 'PUT') return new Response();
      if (rejected) return reply('45000030', { message: config.apiKey }, 403);
      return reply(url.endsWith('/submit') ? '20000000' : '20000003');
    } });
    if (rejected) await assert.rejects(pending, error => /权限/.test(error.message) && !error.message.includes(config.apiKey));
    else assert.equal((await pending).noSpeech, true);
    assert.equal(removed, true);
  }
});

test('poll timeout retains the task and expiration requires explicit new submission', async () => {
  const f = fixture();
  await assert.rejects(f.call({ taskTimeoutMs: 0, fetchImpl: async (_url, req) => req.method === 'PUT' ? new Response() : reply() }), error => error.code === 'ASR_TIMEOUT');
  assert.equal(f.state().submitted, true);
  let deleted = false;
  await assert.rejects(f.call({ fetchImpl: async (url, req) => {
    if (req.method === 'DELETE') { deleted = true; return new Response(); }
    assert.ok(url.endsWith('/query')); return reply('45000092');
  } }), error => error.code === 'ASR_TASK_EXPIRED');
  assert.equal(deleted, true);
});

test('query result size is bounded and malformed responses never remove the only recoverable task', async () => {
  for (const response of [new Response('secret', { headers: { 'X-Api-Status-Code': '20000000', 'Content-Length': 17 * 1024 ** 2 } }), reply('20000000', null)]) {
    const f = fixture();
    await assert.rejects(f.call({ fetchImpl: async (url, req) => {
      assert.notEqual(req.method, 'DELETE');
      return req.method === 'PUT' ? new Response() : url.endsWith('/submit') ? reply() : response;
    } }), error => /ASR_RESPONSE_TOO_LARGE|ASR_INVALID_RESPONSE/.test(error.code));
    assert.equal(f.state().submitted, true);
  }
});
