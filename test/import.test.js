import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { createImportService } from '../server/import/service.js';
import { wav, createCaptureService } from '../server/capture/service.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(10); }
  throw new Error('Timed out waiting for recording import');
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fakeDecode = seconds => async ({ outputPath }) => fs.writeFileSync(outputPath, Buffer.alloc(Math.round(seconds * 32000)), { mode: 0o600 });
const volcResponse = (segments, durationMs) => new Response(JSON.stringify({
  audio_info: { duration: durationMs },
  result: {
    text: segments.map(segment => segment.text).join(' '),
    utterances: segments.map(segment => ({ text: segment.text, start_time: segment.start * 1000,
      end_time: segment.end * 1000, additions: { speaker_id: segment.speaker } })),
  },
}), { headers: { 'X-Api-Status-Code': '20000000', 'Content-Type': 'application/json' } });

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-import-test-'));
  const store = new Store(dir), submissions = [];
  // Tests never send meeting content or credentials to a real provider.
  store.saveSettings({ fileAsr: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'fixture-asr', apiKey: 'fixture-secret', language: 'zh' }, llm: { baseUrl: 'https://example.invalid', model: 'fixture-llm' } });
  const ai = { submit(meetingId, type) { submissions.push({ meetingId, type }); return store.createJob(meetingId, type); } };
  const service = createImportService({ store, ai, decode: fakeDecode(1), fetchImpl: async () => json({ text: '模拟会议发言' }), ...options });
  const server = http.createServer(async (req, res) => {
    try { const result = await service.receive(req); res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
    catch (error) { if (!res.destroyed) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  service.start();
  t.after(async () => { await service.stop(); await new Promise(resolve => server.close(resolve)); store.close(); });
  async function upload({ contents = Buffer.from('fake fixture audio'), filename = '模拟录音.wav', title = '导入验收会议', goal = '验证导入' } = {}) {
    const form = new FormData(); form.append('file', new Blob([contents], { type: 'audio/wav' }), filename); form.append('title', title); form.append('goal', goal);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: form });
    return { status: response.status, ...await response.json() };
  }
  const finished = id => until(() => { const job = store.getJob(id); return ['done', 'error'].includes(job.status) && job; });
  return { dir, store, ai, service, server, submissions, upload, finished };
}

test('real WAV decoding yields saved PCM, end-of-recording playback and timestamped segment offsets', async t => {
  let requestCount = 0;
  const f = await fixture(t, { decode: undefined, chunkSeconds: 1, fetchImpl: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(request.body.get('word_timestamps'), 'true');
    const bytes = Buffer.from(await request.body.get('file').arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(bytes.readUInt32LE(24), 16000);
    requestCount++;
    return json({ text: `第${requestCount}段`, segments: [{ text: `第${requestCount}段`, start: 0, end: (bytes.length - 44) / 32000, speaker: 0 }] });
  } });
  const pcm = Buffer.alloc(67200); pcm.writeInt16LE(1234, pcm.length - 2);
  const result = await f.upload({ contents: wav(pcm), filename: '../../测试录音.wav' });
  assert.equal(result.status, 202); assert.equal(result.meeting.source, 'recording_import');
  assert.equal(result.meeting.status, 'ended'); assert.equal(result.meeting.capture.state, 'idle');
  const job = await f.finished(result.job.id); assert.equal(job.status, 'done');
  assert.equal(job.result.durationMs, 2100); assert.equal(job.result.analysisState, 'not_configured');
  assert.equal(requestCount, 3);
  const recording = f.store.getRecording(job.result.recordingId);
  assert.equal(recording.state, 'stopped'); assert.equal(recording.sampleCount, 33600); assert.deepEqual(recording.gaps, []);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'audio', `${recording.id}.pcm`)), pcm);
  const lines = f.store.allTranscript(result.meeting.id);
  assert.equal(lines[1].startMs, 1000); assert.equal(lines[2].endSample, 33600); assert.equal(lines[2].endMs, 2100);
  assert.equal(lines[0].speakerId, 'import-0-speaker-0');
  assert.notEqual(lines[0].speakerId, lines[1].speakerId, 'separate requests do not prove a shared speaker identity');
  const capture = createCaptureService({ server: f.server, store: f.store });
  const tail = capture.readAudio(recording.id, { startSample: 33599, endSample: 33600 });
  assert.equal(tail.readInt16LE(44), 1234); capture.close();
  assert.equal(f.submissions.length, 0);
  assert.equal(job.input.originalFilename, '测试录音.wav');
  assert.ok(fs.existsSync(path.join(f.dir, 'imports', job.input.uploadId, job.input.storedFilename)));
});

test('Volcengine file ASR reuses speech credentials and preserves chunk timing, checkpoints and speaker boundaries', async t => {
  let calls = 0;
  const f = await fixture(t, { decode: fakeDecode(2.1), chunkSeconds: 1, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    const headers = new Headers(request.headers);
    assert.equal(headers.get('X-Api-Key'), 'volc-test-only');
    assert.equal(headers.get('X-Api-Resource-Id'), 'volc.bigasr.auc_turbo');
    assert.equal(headers.get('Authorization'), null, 'the saved OpenAI key must not reach Volcengine');
    const body = JSON.parse(request.body), audio = Buffer.from(body.audio.data, 'base64');
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    const duration = (audio.length - 44) / 32;
    return new Response(JSON.stringify({ audio_info: { duration }, result: { text: `第${calls}段`, utterances: [{ text: `第${calls}段`, end_time: duration, additions: { speaker_id: 0 }, words: [{ text: `第${calls}段`, start_time: 0, end_time: duration }] }] } }), { headers: { 'X-Api-Status-Code': '20000000', 'Content-Type': 'application/json' } });
  } });
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  const { meeting, job } = await f.upload();
  const done = await f.finished(job.id); assert.equal(done.status, 'done', done.error);
  assert.equal(calls, 3); assert.equal(done.result.durationMs, 2100);
  const lines = f.store.allTranscript(meeting.id);
  assert.equal(lines.length, 3); assert.equal(lines[0].startMs, 0);
  assert.equal(lines[1].startMs, 1000); assert.equal(lines[2].endMs, 2100);
  assert.equal(lines[2].endSample, 33600);
  assert.equal(lines[0].speakerId, 'import-0-speaker-0');
  assert.equal(lines[1].speakerId, 'import-1-speaker-0');
  assert.deepEqual(f.store.getRecording(done.result.recordingId).gaps, []);
  f.service.retry(meeting.id); assert.equal(calls, 3, 'a finished import is not transcribed again');
});

test('default Volcengine import keeps recurring speakers in the same participant beyond minute boundaries', async t => {
  const expected = [
    { text: '第一位介绍讨论目标。', start: 0.1, end: 4.2, speaker: 1 },
    { text: '第二位补充自己的判断。', start: 30.5, end: 34.75, speaker: 2 },
    { text: '第一位在一分钟后继续回应。', start: 61.25, end: 67.5, speaker: 1 },
    { text: '第二位在录音结尾补充。', start: 121.75, end: 125, speaker: 2 },
  ];
  let calls = 0;
  const f = await fixture(t, { decode: fakeDecode(125), fetchImpl: async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body), bytes = Buffer.from(body.audio.data, 'base64');
    assert.equal(body.request.enable_speaker_info, true);
    assert.equal((bytes.length - 44) / 32000, 125, 'the provider receives the complete meeting');
    return volcResponse(expected, 125000);
  } });
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  const { meeting, job } = await f.upload();
  const done = await f.finished(job.id);
  assert.equal(done.status, 'done', done.error); assert.equal(calls, 1);
  assert.equal(done.progress.totalChunks, 1);
  const lines = f.store.allTranscript(meeting.id);
  assert.deepEqual(lines.map(line => ({ text: line.text, start: line.startMs / 1000, end: line.endMs / 1000 })),
    expected.map(({ text, start, end }) => ({ text, start, end })));
  assert.equal(lines[0].participantId, lines[2].participantId);
  assert.equal(lines[1].participantId, lines[3].participantId);
  assert.notEqual(lines[0].participantId, lines[1].participantId);
  assert.equal(f.store.listParticipants(meeting.id).length, 2);
  assert.ok(lines.every(line => line.timing !== 'chunk'));
  assert.equal(lines.at(-1).endSample, 125 * 16000);
  assert.deepEqual(f.store.getRecording(done.result.recordingId).gaps, []);
});

test('long Volcengine results preserve more than 1000 sentences and 20000 characters without losing speakers or timings', async t => {
  const expected = Array.from({ length: 1001 }, (_, index) => ({
    text: `第${index}段会议发言，需要完整保留这句话及其发言人，不能退化成整段文字。`,
    start: index / 10, end: (index * 100 + 80) / 1000, speaker: index % 3,
  }));
  assert.ok(expected.map(line => line.text).join('').length > 20000);
  let calls = 0;
  const f = await fixture(t, { decode: fakeDecode(100.1), fetchImpl: async () => {
    calls++; return volcResponse(expected, 100100);
  } });
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  const { meeting, job } = await f.upload();
  const done = await until(() => { const current = f.store.getJob(job.id); return ['done', 'error'].includes(current.status) && current; }, 30000);
  assert.equal(done.status, 'done', done.error); assert.equal(calls, 1);
  const lines = f.store.allTranscript(meeting.id);
  assert.equal(done.result.transcriptCount, expected.length);
  assert.deepEqual(lines.map(line => line.text), expected.map(line => line.text));
  assert.deepEqual(lines.map(line => [line.startSample, line.endSample]),
    expected.map(line => [Math.round(line.start * 16000), Math.round(line.end * 16000)]));
  assert.ok(lines.every(line => line.timing !== 'chunk' && line.speakerId !== 'unknown'));
  assert.equal(new Set(lines.map(line => line.participantId)).size, 3);
  assert.equal(new Set(lines.map(line => line.id)).size, expected.length);
});

test('the per-sentence storage limit never silently truncates an oversized ASR result', async t => {
  for (const [label, characters, timestamps, expectedStatus] of [
    ['a sentence exactly at the limit is retained', 20000, true, 'done'],
    ['an oversized timestamped sentence is rejected', 20001, true, 'error'],
    ['oversized text without sentence boundaries is rejected', 20001, false, 'error'],
  ]) await t.test(label, async t => {
    const text = '文'.repeat(characters);
    const f = await fixture(t, { fetchImpl: async () => timestamps
      ? volcResponse([{ text, start: 0, end: 0.9, speaker: 1 }], 1000)
      : new Response(JSON.stringify({ audio_info: { duration: 1000 }, result: { text } }), { headers: { 'X-Api-Status-Code': '20000000' } }) });
    f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
    const { meeting, job } = await f.upload(); const finished = await f.finished(job.id);
    assert.equal(finished.status, expectedStatus, finished.error);
    const lines = f.store.allTranscript(meeting.id);
    if (expectedStatus === 'done') {
      assert.equal(lines.length, 1); assert.equal(lines[0].text, text);
      assert.equal(lines[0].endSample, 14400); assert.notEqual(lines[0].speakerId, 'unknown');
    } else {
      assert.equal(lines.length, 0, 'no truncated substitute may be persisted as a successful transcript');
      assert.ok(finished.error);
    }
    const recording = f.store.getRecording(finished.input.recordingId);
    assert.equal(recording.sampleCount, 16000);
    assert.equal(fs.statSync(path.join(f.dir, 'audio', `${recording.id}.pcm`)).size, 32000);
    assert.ok(fs.existsSync(path.join(f.dir, 'imports', finished.input.uploadId, finished.input.storedFilename)));
  });
});

test('Volcengine import plans fit the actual WAV byte limit at the last sample and split only beyond it', async t => {
  // PCM is 16 kHz / 16-bit mono; the request limit includes the 44-byte WAV header.
  const lastFittingSample = 49_999_978;
  for (const [label, sampleCount, expectedChunks, chunkSeconds] of [
    ['one sample below the limit', lastFittingSample - 1, 1, undefined],
    ['exactly at the limit', lastFittingSample, 1, undefined],
    ['one sample above the limit', lastFittingSample + 1, 2, undefined],
    ['an explicit two-hour override still respects the byte limit', 2 * 3600 * 16000, 3, 7200],
  ]) await t.test(label, async t => {
    let calls = 0, interruptedAfterPlanning = false;
    const f = await fixture(t, { chunkSeconds, decode: async ({ outputPath }) => {
      // Sparse files let us inspect real persisted plans without allocating huge request bodies.
      const fd = fs.openSync(outputPath, 'wx', 0o600);
      try { fs.ftruncateSync(fd, sampleCount * 2); } finally { fs.closeSync(fd); }
    }, fetchImpl: async () => { calls++; throw new Error('planning-only fixture must not submit audio'); } });
    f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
    const updateJob = f.store.updateJob.bind(f.store);
    f.store.updateJob = (id, patch) => {
      const saved = updateJob(id, patch);
      if (!interruptedAfterPlanning && patch.input?.decoded && patch.progress?.phase === 'transcribing') {
        interruptedAfterPlanning = true;
        throw new Error('simulated interruption after the decoded plan was saved');
      }
      return saved;
    };
    const { job } = await f.upload(); const stopped = await f.finished(job.id);
    assert.equal(interruptedAfterPlanning, true); assert.equal(calls, 0);
    assert.equal(stopped.input.chunkSamples, lastFittingSample);
    assert.equal(stopped.progress.totalChunks, expectedChunks);
    assert.equal(f.store.getRecording(stopped.input.recordingId).sampleCount, sampleCount);
    assert.ok(stopped.input.chunkSamples * 2 + 44 <= 100_000_000);
    assert.ok(stopped.input.chunkSamples <= 2 * 3600 * 16000);
  });
});

test('persisted Volcengine plan survives provider changes and restart while resuming exact offsets and host edits', async t => {
  let calls = 0;
  const f = await fixture(t, { chunkSeconds: 2, decode: fakeDecode(4.25), fetchImpl: async (_url, request) => {
    if (++calls === 1) return volcResponse([{ text: '第一段原始发言', start: 0.1, end: 1.9, speaker: 1 }], 2000);
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } });
  f.store.saveSettings({ asr: { apiKey: 'volc-original-key' }, fileAsr: { provider: 'volcengine', resourceId: 'volc.bigasr.auc_turbo' } });
  const { meeting, job } = await f.upload(); await until(() => calls === 2);
  await f.service.stop();
  const saved = f.store.getJob(job.id), first = f.store.allTranscript(meeting.id)[0];
  assert.equal(saved.status, 'queued'); assert.equal(saved.input.completedChunks, 1);
  assert.equal(saved.input.chunkSamples, 32000);
  assert.deepEqual(saved.input.asrPlan, { provider: 'volcengine', resourceId: 'volc.bigasr.auc_turbo' });
  assert.doesNotMatch(JSON.stringify(saved.input), /volc-original-key|fixture-secret/);
  f.store.editTranscript(meeting.id, first.id, { text: '主持人已确认的发言' });
  f.store.updateParticipant(meeting.id, first.participantId, { name: '已确认成员' });
  f.store.saveSettings({ asr: { apiKey: 'volc-rotated-key' }, fileAsr: { provider: 'openai', baseUrl: 'http://127.0.0.1:8888/v1', model: 'other-model', resourceId: 'other-resource' } });

  const restored = new Store(f.dir), lengths = [];
  const resumed = createImportService({ store: restored, ai: f.ai, chunkSeconds: 0.5, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    const headers = new Headers(request.headers);
    assert.equal(headers.get('X-Api-Key'), 'volc-rotated-key', 'credentials may be corrected without changing the saved provider');
    assert.equal(headers.get('X-Api-Resource-Id'), 'volc.bigasr.auc_turbo');
    const audio = Buffer.from(JSON.parse(request.body).audio.data, 'base64'), seconds = (audio.length - 44) / 32000;
    lengths.push(seconds);
    return volcResponse([{ text: `恢复后的第${lengths.length}段`, start: 0, end: seconds, speaker: 1 }], seconds * 1000);
  } });
  try {
    resumed.start();
    const done = await until(() => { const current = restored.getJob(job.id); return ['done', 'error'].includes(current.status) && current; });
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(lengths, [2, 0.25]);
    assert.deepEqual(done.input.asrPlan, saved.input.asrPlan); assert.equal(done.input.chunkSamples, 32000);
    const lines = restored.allTranscript(meeting.id);
    assert.equal(lines.length, 3); assert.equal(lines[0].id, first.id); assert.equal(lines[0].text, '主持人已确认的发言');
    assert.equal(restored.listParticipants(meeting.id).find(person => person.id === first.participantId).name, '已确认成员');
    assert.deepEqual(lines.slice(1).map(line => [line.startSample, line.endSample]), [[32000, 64000], [64000, 68000]]);
    assert.notEqual(lines[1].participantId, lines[2].participantId, 'independent long requests still have independent speaker identities');
    assert.equal(done.progress.processedSeconds, 4.25); assert.deepEqual(restored.getRecording(done.result.recordingId).gaps, []);
  } finally { await resumed.stop(); restored.close(); }
});

test('legacy imports without a saved plan resume their original minute checkpoints instead of adopting long requests', async t => {
  let calls = 0;
  const f = await fixture(t, { chunkSeconds: 60, decode: fakeDecode(120.25), fetchImpl: async (_url, request) => {
    if (++calls === 1) return volcResponse([{ text: '旧版已保存的第一分钟', start: 0, end: 60, speaker: 1 }], 60000);
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } });
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  const { meeting, job } = await f.upload(); await until(() => calls === 2); await f.service.stop();
  const input = { ...f.store.getJob(job.id).input }; delete input.chunkSamples; delete input.asrPlan;
  f.store.updateJob(job.id, { input });
  const first = f.store.allTranscript(meeting.id)[0];
  f.store.editTranscript(meeting.id, first.id, { text: '旧版人工更正仍需保留' });
  const restored = new Store(f.dir), lengths = [];
  const resumed = createImportService({ store: restored, ai: f.ai, chunkSeconds: 1, fetchImpl: async (_url, request) => {
    const bytes = Buffer.from(JSON.parse(request.body).audio.data, 'base64'), seconds = (bytes.length - 44) / 32000;
    lengths.push(seconds);
    return volcResponse([{ text: `旧任务恢复${lengths.length}`, start: 0, end: seconds, speaker: 1 }], seconds * 1000);
  } });
  try {
    resumed.start();
    const done = await until(() => { const current = restored.getJob(job.id); return ['done', 'error'].includes(current.status) && current; });
    assert.equal(done.status, 'done', done.error); assert.deepEqual(lengths, [60, 0.25]);
    assert.equal(done.input.chunkSamples, 60 * 16000);
    const lines = restored.allTranscript(meeting.id);
    assert.equal(lines.length, 3); assert.equal(lines[0].id, first.id); assert.equal(lines[0].text, '旧版人工更正仍需保留');
    assert.deepEqual(lines.map(line => [line.startSample, line.endSample]), [[0, 960000], [960000, 1920000], [1920000, 1924000]]);
    assert.deepEqual(lines.map(line => line.speakerId), ['import-0-speaker-1', 'import-1-speaker-1', 'import-2-speaker-1']);
    assert.deepEqual(restored.getRecording(done.result.recordingId).gaps, []);
  } finally { await resumed.stop(); restored.close(); }
});

test('an explicit retry can correct an endpoint or model but cannot silently switch an existing import to another provider', async t => {
  let corrected = false, successfulCalls = 0;
  const f = await fixture(t, { chunkSeconds: 1, decode: fakeDecode(2.25), fetchImpl: async (url, request) => {
    if (!corrected) return json({ error: 'wrong fixture endpoint or model' }, 404);
    assert.equal(url, 'http://127.0.0.1:8888/v1/audio/transcriptions');
    assert.equal(request.body.get('model'), 'corrected-model');
    const bytes = Buffer.from(await request.body.get('file').arrayBuffer()), end = (bytes.length - 44) / 32000;
    successfulCalls++;
    return json({ text: `修正后第${successfulCalls}段`, segments: [{ text: `修正后第${successfulCalls}段`, start: 0, end, speaker: 1 }] });
  } });
  const { meeting, job } = await f.upload(); const failed = await f.finished(job.id);
  assert.equal(failed.status, 'error'); assert.equal(failed.input.chunkSamples, 16000);
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  assert.throws(() => f.service.retry(meeting.id), /服务|提供|切回/);
  assert.equal(f.store.getJob(job.id).status, 'error');
  f.store.saveSettings({ fileAsr: { provider: 'openai', baseUrl: 'http://127.0.0.1:8888/v1', model: 'corrected-model', language: 'en' } });
  corrected = true; f.service.retry(meeting.id);
  const done = await f.finished(job.id); assert.equal(done.status, 'done', done.error);
  assert.equal(successfulCalls, 3); assert.equal(done.input.chunkSamples, failed.input.chunkSamples);
  assert.deepEqual(done.input.asrPlan, { provider: 'openai', baseUrl: 'http://127.0.0.1:8888/v1', model: 'corrected-model', language: 'en' });
  assert.deepEqual(f.store.allTranscript(meeting.id).map(line => [line.startMs, line.endMs]), [[0, 1000], [1000, 2000], [2000, 2250]]);
});

test('a long response can stop during sentence persistence and resume its checkpoint without duplicate ASR or lost edits', async t => {
  const expected = Array.from({ length: 120 }, (_, index) => ({ text: `第${index}句连续讨论。`, start: index, end: index + 0.8, speaker: index % 2 }));
  let calls = 0, appends = 0, stopping;
  const f = await fixture(t, { decode: fakeDecode(120), fetchImpl: async () => { calls++; return volcResponse(expected, 120000); } });
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine' } });
  const append = f.store.appendTranscript.bind(f.store);
  f.store.appendTranscript = (...args) => {
    const saved = append(...args);
    if (++appends === 25) stopping = f.service.stop();
    return saved;
  };
  const { meeting, job } = await f.upload();
  await until(() => appends >= 25 && f.store.getJob(job.id).status === 'queued'); await stopping;
  const partial = f.store.allTranscript(meeting.id);
  assert.ok(partial.length > 0 && partial.length < expected.length, 'shutdown must not finish committing every remaining sentence');
  assert.equal(f.store.getJob(job.id).input.completedChunks, 0, 'partially committed chunks remain resumable');
  f.store.editTranscript(meeting.id, partial[0].id, { text: '中断期间主持人修正' });
  f.store.appendTranscript = append;
  f.service.start(); const done = await f.finished(job.id);
  assert.equal(done.status, 'done', done.error); assert.equal(calls, 1);
  const lines = f.store.allTranscript(meeting.id);
  assert.equal(lines.length, expected.length); assert.equal(new Set(lines.map(line => line.id)).size, expected.length);
  assert.equal(lines[0].text, '中断期间主持人修正'); assert.equal(lines[0].id, partial[0].id);
  assert.deepEqual(lines.slice(1).map(line => line.text), expected.slice(1).map(line => line.text));
  assert.deepEqual(lines.map(line => [line.startSample, line.endSample]), expected.map(line => [Math.round(line.start * 16000), Math.round(line.end * 16000)]));
  assert.equal(new Set(lines.map(line => line.participantId)).size, 2);
});

test('failed ASR retries only unfinished chunks and preserves host corrections with approximate timing', async t => {
  let calls = 0;
  const f = await fixture(t, { decode: fakeDecode(2.1), chunkSeconds: 1, fetchImpl: async () => {
    calls++; if (calls === 2) return new Response('fixture-secret internal provider error', { status: 500 });
    return json({ text: `分块${calls}` });
  } });
  const { meeting, job } = await f.upload();
  const failed = await f.finished(job.id);
  assert.equal(failed.status, 'error'); assert.doesNotMatch(failed.error, /fixture-secret/);
  assert.equal(failed.input.completedChunks, 1); assert.equal(failed.progress.completedChunks, 1);
  const original = f.store.allTranscript(meeting.id)[0];
  assert.equal(original.timing, 'chunk'); assert.equal(original.speakerId, 'unknown');
  f.store.editTranscript(meeting.id, original.id, { text: '主持人更正的第一段' });
  assert.equal(f.store.getRecording(failed.input.recordingId).gaps[0].startSample, 16000);
  const retry = f.service.retry(meeting.id); assert.equal(retry.id, job.id);
  assert.equal(f.service.retry(meeting.id).id, job.id, 'concurrent retry returns the same job');
  assert.equal((await f.finished(job.id)).status, 'done');
  assert.equal(calls, 4);
  const lines = f.store.allTranscript(meeting.id);
  assert.equal(lines.length, 3); assert.equal(lines[0].text, '主持人更正的第一段');
  assert.equal(lines[2].startSample, 32000); assert.equal(lines[2].endSample, 33600);
  assert.equal(f.service.retry(meeting.id).status, 'done'); assert.equal(calls, 4);
});

test('durable chunk response resumes a partially committed chunk without repeat ASR or overwritten edits', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; return json({ text: '第一句 第二句', segments: [{ text: '第一句', start: 0, end: 0.4 }, { text: '第二句', start: 0.5, end: 0.9 }] }); } });
  const originalAppend = f.store.appendTranscript.bind(f.store); let appends = 0;
  f.store.appendTranscript = (...args) => { if (++appends === 2) throw new Error('simulated disk interruption'); return originalAppend(...args); };
  const { meeting, job } = await f.upload();
  assert.equal((await f.finished(job.id)).status, 'error');
  const first = f.store.allTranscript(meeting.id)[0]; f.store.editTranscript(meeting.id, first.id, { text: '人工保留' });
  f.store.appendTranscript = originalAppend;
  f.service.retry(meeting.id); assert.equal((await f.finished(job.id)).status, 'done');
  assert.equal(calls, 1); assert.equal(f.store.allTranscript(meeting.id).length, 2);
  assert.equal(f.store.allTranscript(meeting.id)[0].text, '人工保留');
});

test('stop aborts active ASR and restart keeps the OpenAI endpoint, model and checkpoint despite changed settings', async t => {
  let calls = 0, wasAborted = false;
  const f = await fixture(t, { chunkSeconds: 1, decode: fakeDecode(2), fetchImpl: async (_url, request) => {
    if (++calls === 1) return json({ text: '重启前已保存' });
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('aborted')); }, { once: true }));
  } });
  const { meeting, job } = await f.upload(); await until(() => calls === 2);
  await f.service.stop(); assert.equal(wasAborted, true); assert.equal(f.store.getJob(job.id).status, 'queued');
  assert.equal(f.store.getJob(job.id).input.completedChunks, 1);
  f.store.saveSettings({ asr: { apiKey: 'volc-test-only' }, fileAsr: { provider: 'volcengine', baseUrl: 'http://127.0.0.1:9998/v1', model: 'changed-model', language: 'en' } });
  let resumedCalls = 0;
  const restored = new Store(f.dir);
  const resumed = createImportService({ store: restored, ai: f.ai, chunkSeconds: 0.5, fetchImpl: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
    assert.equal(request.body.get('model'), 'fixture-asr');
    assert.equal(request.body.get('language'), 'zh');
    const bytes = Buffer.from(await request.body.get('file').arrayBuffer());
    assert.equal((bytes.length - 44) / 32000, 1);
    resumedCalls++; return json({ text: '重启后继续' });
  } });
  resumed.start();
  const done = await until(() => restored.getJob(job.id).status === 'done' && restored.getJob(job.id));
  assert.equal(done.result.transcriptCount, 2); assert.equal(resumedCalls, 1);
  assert.equal(restored.allTranscript(meeting.id)[0].text, '重启前已保存');
  await resumed.stop(); restored.close();
});

test('unusable segment timestamps fall back to whole chunk and no-speech intervals remain replayable', async t => {
  let calls = 0;
  const f = await fixture(t, { chunkSeconds: 1, decode: fakeDecode(2), fetchImpl: async () => ++calls === 1 ? json({ text: '时间戳无效但保留文字', segments: [{ text: '时间戳无效但保留文字', start: 1.01, end: 1.04, speaker: 'Alice' }] }) : json({ text: '' }) });
  const { meeting, job } = await f.upload(); const done = await f.finished(job.id);
  assert.equal(done.status, 'done'); assert.equal(done.result.transcriptCount, 1);
  const line = f.store.allTranscript(meeting.id)[0];
  assert.equal(line.timing, 'chunk'); assert.equal(line.startSample, 0); assert.equal(line.endSample, 16000); assert.equal(line.speakerId, 'unknown');
  const gap = f.store.getRecording(done.result.recordingId).gaps[0];
  assert.equal(gap.startSample, 16000); assert.equal(gap.endSample, 32000); assert.equal(gap.importKind, 'no_speech');
});

test('completed import submits AI minutes only when configured and treats scheduling failure as a separate state', async t => {
  const f = await fixture(t);
  f.store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:9999/v1' } });
  const { meeting, job } = await f.upload(); const done = await f.finished(job.id);
  assert.equal(done.status, 'done'); assert.equal(done.result.analysisState, 'queued');
  assert.deepEqual(f.submissions, [{ meetingId: meeting.id, type: 'minutes' }]);
  assert.equal(f.store.getJob(done.result.analysisJobId).type, 'minutes');
  f.ai.submit = () => { throw new Error('a separate scheduling problem'); };
  const second = await f.upload(); const failedAnalysis = await f.finished(second.job.id);
  assert.equal(failedAnalysis.status, 'done'); assert.equal(failedAnalysis.result.analysisState, 'failed');
  assert.equal(failedAnalysis.result.transcriptCount, 1);
});

test('audio parsing failures retain the source, never follow media playlist URLs, and make no ASR call', async t => {
  let providerCalls = 0, networkCalls = 0;
  const decoy = http.createServer((_req, res) => { networkCalls++; res.end('not audio'); });
  decoy.listen(0, '127.0.0.1'); await once(decoy, 'listening'); t.after(() => new Promise(resolve => decoy.close(resolve)));
  const f = await fixture(t, { decode: undefined, fetchImpl: async () => { providerCalls++; return json({ text: 'must not happen' }); } });
  const result = await f.upload({ filename: 'playlist.wav', contents: Buffer.from(`#EXTM3U\nhttp://127.0.0.1:${decoy.address().port}/private\n`) });
  const failed = await f.finished(result.job.id);
  assert.equal(failed.status, 'error'); assert.match(failed.error, /无法读取/);
  assert.equal(providerCalls, 0); assert.equal(networkCalls, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, 'imports', failed.input.uploadId, failed.input.storedFilename), 'utf8').startsWith('#EXTM3U'), true);
  assert.equal(f.store.getMeeting(result.meeting.id).status, 'ended');
  assert.equal(f.store.getRecording(failed.input.recordingId).state, 'stopped');
});

test('oversized and interrupted uploads retain partial bytes without creating a completed meeting', async t => {
  const f = await fixture(t, { maxUploadBytes: 32 });
  const oversized = await f.upload({ contents: Buffer.alloc(64) });
  assert.equal(oversized.status, 413); assert.equal(f.store.listMeetings().length, 0);
  const saved = fs.readdirSync(path.join(f.dir, 'imports'));
  assert.equal(fs.statSync(path.join(f.dir, 'imports', saved[0], 'upload.partial')).size, 32);
  const req = http.request({ hostname: '127.0.0.1', port: f.server.address().port, method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=interrupted' } });
  req.on('error', () => {});
  req.write('--interrupted\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\npartial');
  await until(() => fs.readdirSync(path.join(f.dir, 'imports')).length === 2);
  req.destroy(); await pause(30);
  assert.equal(f.store.listMeetings().length, 0);
  assert.equal(fs.readdirSync(path.join(f.dir, 'imports')).length, 2);
});

test('oversized ASR responses stop reading at the byte limit and preserve a retryable recording', async t => {
  let reads = 0, cancelled = false;
  const f = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  })) });
  const { job } = await f.upload(); const failed = await f.finished(job.id);
  assert.equal(failed.status, 'error'); assert.equal(cancelled, true);
  assert.ok(reads <= 4, 'the stream is cancelled after the first bytes beyond 2 MiB, with at most one prefetched chunk');
  assert.equal(failed.input.completedChunks, 0);
  assert.equal(f.store.getRecording(failed.input.recordingId).sampleCount, 16000);
});

test('import publishes newly persisted text to recognition without letting recognition failure stop import', async t => {
  const notifications = [];
  const f = await fixture(t, { decode: fakeDecode(2), chunkSeconds: 1, onTranscript: id => { notifications.push(id); throw new Error('optional recognition is unavailable'); } });
  const result = await f.upload();
  const job = await f.finished(result.job.id);
  assert.equal(job.status, 'done');
  assert.deepEqual(notifications, [result.meeting.id, result.meeting.id]);
  assert.equal(f.store.allTranscript(result.meeting.id).length, 2);
  f.service.retry(result.meeting.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.length, 2, 'a completed import cannot retrigger all historical speakers');
});
