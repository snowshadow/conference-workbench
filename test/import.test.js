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

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-import-test-'));
  const store = new Store(dir), submissions = [];
  // Tests never send meeting content or credentials to a real provider.
  store.saveSettings({ fileAsr: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'fixture-asr', apiKey: 'fixture-secret' }, llm: { baseUrl: 'https://example.invalid', model: 'fixture-llm' } });
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

test('stop aborts active ASR and a new service resumes the persisted checkpoint', async t => {
  let calls = 0, wasAborted = false;
  const f = await fixture(t, { chunkSeconds: 1, decode: fakeDecode(2), fetchImpl: async (_url, request) => {
    if (++calls === 1) return json({ text: '重启前已保存' });
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('aborted')); }, { once: true }));
  } });
  const { meeting, job } = await f.upload(); await until(() => calls === 2);
  await f.service.stop(); assert.equal(wasAborted, true); assert.equal(f.store.getJob(job.id).status, 'queued');
  assert.equal(f.store.getJob(job.id).input.completedChunks, 1);
  let resumedCalls = 0;
  const restored = new Store(f.dir);
  const resumed = createImportService({ store: restored, ai: f.ai, chunkSeconds: 1, fetchImpl: async () => { resumedCalls++; return json({ text: '重启后继续' }); } });
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
