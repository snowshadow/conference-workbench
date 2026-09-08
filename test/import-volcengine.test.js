import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeVolcAudio } from '../server/import/volcengine.js';

const audio = Buffer.from('RIFF fixture WAV audio');
const config = { apiKey: 'fixture-private-key' };
const response = (body, { code = '20000000', status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'X-Api-Status-Code': code, 'X-Tt-Logid': '20260908SAFELOGID', ...headers },
});
const call = options => transcribeVolcAudio({ audio, config, ...options });

test('WAV bytes go directly to the fixed flash endpoint with scoped auth and normalize milliseconds', async () => {
  const result = await call({ config: { ...config, url: 'https://untrusted.invalid', baseUrl: 'https://untrusted.invalid' }, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers['X-Api-Key'], config.apiKey);
    assert.equal(request.headers['X-Api-App-Key'], undefined);
    assert.equal(request.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
    assert.match(request.headers['X-Api-Request-Id'], /^[\da-f-]{36}$/);
    assert.equal(request.headers['X-Api-Sequence'], '-1');
    const body = JSON.parse(request.body);
    assert.deepEqual(Buffer.from(body.audio.data, 'base64'), audio);
    assert.equal(body.audio.url, undefined);
    assert.equal(body.request.show_utterances, true);
    assert.equal(body.request.enable_speaker_info, true);
    assert.equal(body.request.enable_ddc, false);
    return response({ audio_info: { duration: 3000 }, result: { text: '会议开始。', utterances: [
      { text: '会议开始。', start_time: 100, end_time: 2800, additions: { speaker: 0 } },
    ] } });
  } });
  assert.deepEqual(result, { text: '会议开始。', durationMs: 3000, segments: [{ text: '会议开始。', start: 0.1, end: 2.8, speaker_id: 0 }] });
});

test('legacy credentials are supported and API key takes precedence', async () => {
  for (const includeApiKey of [false, true]) {
    await call({ config: { appKey: 'fixture-app', accessKey: 'fixture-access', ...(includeApiKey ? config : {}) }, fetchImpl: async (_url, request) => {
      assert.equal(request.headers['X-Api-Key'], includeApiKey ? config.apiKey : undefined);
      assert.equal(request.headers['X-Api-App-Key'], includeApiKey ? undefined : 'fixture-app');
      assert.equal(request.headers['X-Api-Access-Key'], includeApiKey ? undefined : 'fixture-access');
      return response({ result: { text: '' } });
    } });
  }
});

test('word boundaries establish missing sentence times without requiring definite', async () => {
  const result = await call({ fetchImpl: async () => response({ result: { additions: { duration: '4000' }, text: '先对齐。', utterances: [{ text: '先对齐。', words: [
    { text: '先', start_time: 500, end_time: 900 }, { text: '对齐', start_time: 1000, end_time: 2500 },
  ], additions: { speaker: '2' } }] } }) });
  assert.deepEqual(result, { text: '先对齐。', durationMs: 4000, segments: [{ text: '先对齐。', start: 0.5, end: 2.5, speaker_id: '2' }] });
});

test('missing real word boundaries, reversed times and missing text keep full text for chunk timing', async () => {
  for (const utterances of [
    [{ text: '完整原话', words: [{ text: '完整', end_time: 600 }, { text: '原话', start_time: 800, end_time: 1300 }] }],
    [{ text: '完整原话', start_time: 1500, end_time: 1000 }],
    [{ text: '原话', start_time: 0, end_time: 1000 }],
    [{ text: '完整原话', start_time: 0, end_time: 3000 }],
  ]) {
    const result = await call({ fetchImpl: async () => response({ audio_info: { duration: 2000 }, result: { text: '完整原话', utterances } }) });
    assert.equal(result.text, '完整原话');
    assert.deepEqual(result.segments, []);
  }
});

test('explicit sentence times take precedence over words and complete utterances preserve text when overall text is absent', async () => {
  const result = await call({ fetchImpl: async () => response({ result: { utterances: [
    { text: '第一句', start_time: 100, end_time: 900, words: [{ start_time: 200, end_time: 800 }] },
    { text: '第二句', start_time: 1000, end_time: 2000, speaker_id: 0 },
  ] } }) });
  assert.equal(result.text, '第一句 第二句');
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].start, 0.1);
  assert.equal(result.segments[0].end, 0.9);
  assert.equal(result.segments[1].speaker_id, 0);
});

test('silence is a successful no-speech result even when the service omits a JSON body', async () => {
  const result = await call({ fetchImpl: async () => new Response(null, { headers: { 'X-Api-Status-Code': '20000003' } }) });
  assert.deepEqual(result, { text: '', segments: [], noSpeech: true });
});

test('HTTP and provider errors are checked independently without exposing upstream content', async () => {
  for (const [status, code, message] of [[401, '20000000', /认证/], [403, '20000000', /权限/], [200, '45000151', /格式/], [200, '55000031', /繁忙/], [429, '20000000', /繁忙/]]) {
    await assert.rejects(call({ fetchImpl: async () => response({ error: config.apiKey }, { status, code, headers: { 'X-Api-Message': config.apiKey } }) }), error => {
      assert.match(error.publicMessage, message);
      assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /fixture-private-key/);
      assert.equal(error.logId, '20260908SAFELOGID');
      if (status !== 200) assert.equal(error.code, `HTTP_${status}`);
      return true;
    });
  }
  await assert.rejects(call({ fetchImpl: async () => response({}, { status: 403, headers: { 'X-Tt-Logid': config.apiKey } }) }), error => {
    assert.equal(error.logId, undefined); return true;
  });
});

test('missing protocol status, malformed JSON and malformed result never become empty successful transcripts', async () => {
  for (const makeResponse of [
    () => new Response('{}'),
    () => new Response(config.apiKey, { headers: { 'X-Api-Status-Code': '20000000' } }),
    () => response({ error: 'unexpected envelope' }),
    () => response({ result: { utterances: [null] } }),
  ]) {
    await assert.rejects(call({ fetchImpl: async () => makeResponse() }), error => error.code === 'ASR_INVALID_RESPONSE' && !error.message.includes(config.apiKey));
  }
});

test('response streaming stops at the byte limit and cancels the upstream body', async () => {
  let cancelled = false, pulls = 0;
  await assert.rejects(call({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 ** 2)); },
    cancel() { cancelled = true; },
  }), { headers: { 'X-Api-Status-Code': '20000000' } }) }), error => error.code === 'ASR_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true); assert.ok(pulls <= 19);
});

test('oversized declared responses are rejected before reading their bodies', async () => {
  let cancelled = false;
  await assert.rejects(call({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'X-Api-Status-Code': '20000000', 'Content-Length': String(17 * 1024 ** 2) },
  }) }), error => error.code === 'ASR_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('abort and timeout work while connecting and while reading a stalled response body', async () => {
  for (const stalledBody of [false, true]) {
    const controller = new AbortController(); let entered; const started = new Promise(resolve => { entered = resolve; });
    let requestSignal, cancelled = false;
    const fetchImpl = async (_url, request) => {
      requestSignal = request.signal; entered();
      return stalledBody ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'X-Api-Status-Code': '20000000' } }) : new Promise(() => {});
    };
    const pending = call({ signal: controller.signal, fetchImpl });
    await started; controller.abort(new Error(config.apiKey));
    await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ASR_ABORTED' && !error.message.includes(config.apiKey));
    assert.equal(requestSignal.aborted, true);
    if (stalledBody) assert.equal(cancelled, true);
    await assert.rejects(call({ fetchImpl, requestTimeoutMs: 15 }), error => error.code === 'ASR_TIMEOUT');
    assert.equal(requestSignal.aborted, true);
  }
});

test('invalid local inputs and already-aborted requests do not reach the provider', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not be called'); };
  for (const options of [{ audio: Buffer.alloc(0) }, { audio: 'not bytes' }, { config: {} }, { config: { appKey: 'only-one-half' } }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(call({ fetchImpl, ...options }));
  }
  await assert.rejects(call({ fetchImpl, audio: Buffer.alloc(100_000_001) }), error => error.code === 'ASR_AUDIO_TOO_LARGE');
  assert.equal(calls, 0);
});

test('network errors do not leak provider URLs or credentials', async () => {
  await assert.rejects(call({ fetchImpl: async () => { throw new Error(`network issue ${config.apiKey}`); } }), error => error.code === 'ASR_NETWORK_ERROR' && !error.message.includes(config.apiKey));
  await assert.rejects(call({ fetchImpl: async () => { throw Object.assign(new Error(config.apiKey), { publicMessage: config.apiKey }); } }), error => error.code === 'ASR_NETWORK_ERROR' && !error.message.includes(config.apiKey));
});
