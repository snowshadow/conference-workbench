import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../server/store.js';
import { createCaptureService } from '../server/capture/service.js';
import { normalizeAsrResult } from '../server/capture/protocol.js';
import { PCMResampler } from '../src/lib/audio-pipeline.js';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for capture state');
}
async function fixture(t, factory, onTranscript = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-capture-test-'));
  const store = new Store(dir), server = http.createServer();
  const sessions = [];
  const capture = createCaptureService({ server, store, onTranscript, onEnded: id => store.updateMeeting(id, { status: 'ended' }), asrFactory: options => {
    sessions.push(options);
    return factory ? factory(options) : { push() {}, finish: async () => { options.onState({ asrState: 'stopped' }); }, close() {} };
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const meeting = store.createMeeting({ title: 'Capture test' });
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); capture.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
  async function connect(id = meeting.id) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/capture?meetingId=${id}`, { origin: `http://127.0.0.1:${port}` });
    sockets.push(ws); await once(ws, 'open'); return ws;
  }
  return { capture, store, meeting, sessions, connect, port };
}

test('new finalized ASR text notifies recognition once, and failed recognition cannot interrupt capture', async t => {
  const notified = [];
  const f = await fixture(t, undefined, meetingId => { notified.push(meetingId); throw new Error('optional recognition unavailable'); });
  const ws = await f.connect(), cmd = await begin(f, ws);
  ws.send(Buffer.alloc(32000)); await until(() => f.store.getCommand(cmd.id).status === 'done');
  const result = { epochStartSample: 0, recognitionSessionId: 'session-one', utterances: [{ text: '先讨论接口', startTime: 0, endTime: 800, definite: false, speaker: 1 }] };
  f.sessions[0].onTranscript(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notified.length, 0);
  result.utterances[0].definite = true;
  f.sessions[0].onTranscript(result);
  await until(() => notified.length === 1);
  f.sessions[0].onTranscript(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notified.length, 1, 'identical provider replay must not repeat recognition notification');
  result.utterances[0].text = '先讨论接口边界';
  f.sessions[0].onTranscript(result);
  await until(() => notified.length === 2);
  await finish(f, ws);
  assert.equal(f.store.allTranscript(f.meeting.id)[0].text, '先讨论接口边界');
  assert.equal(f.capture.readAudio(f.store.listRecordings(f.meeting.id)[0].id).length, 32044);
});
async function begin(f, ws, action = 'start') {
  const cmd = f.capture.request(f.meeting.id, action);
  assert.equal(cmd.status, 'needs_user_action');
  ws.send(JSON.stringify({ type: 'begin', commandId: cmd.id }));
  await until(() => f.store.getCommand(cmd.id).status === 'running');
  assert.notEqual(f.capture.getState(f.meeting.id).state, 'recording', 'permission alone is not evidence of actual recording');
  return cmd;
}
async function finish(f, ws, action = 'pause') {
  const cmd = f.capture.request(f.meeting.id, action);
  ws.send(JSON.stringify({ type: 'drained', commandId: cmd.id }));
  await until(() => f.store.getCommand(cmd.id).status === 'done');
  return cmd;
}

test('PCM persists before ASR, pause drains tail, resume has correct recording and meeting offsets', async t => {
  const f = await fixture(t, options => ({
    push(buffer, start) {
      const rec = f.store.listRecordings(f.meeting.id).find(r => r.state === 'recording');
      assert.equal(fs.statSync(path.join(f.store.dataDir, 'audio', `${rec.id}.pcm`)).size, rec.sampleCount * 2);
      options.onState({ asrState: 'reconnecting' });
      options.onGap({ startSample: start, endSample: start + buffer.length / 2, reason: 'ASR unavailable' });
    },
    async finish() {
      options.onTranscript({ epochStartSample: 0, utterances: [{ text: '最后一句', startTime: 0, endTime: 100, definite: true, speaker: '' }] });
    }, close() {},
  }));
  const ws = await f.connect(), cmd = await begin(f, ws);
  const pcm = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i, i * 2);
  ws.send(pcm); await until(() => f.store.getCommand(cmd.id).status === 'done');
  ws.send(Buffer.from([2, 0, 3, 0])); // short final worklet tail
  await finish(f, ws);
  const first = f.store.listRecordings(f.meeting.id)[0];
  assert.equal(first.sampleCount, 1602); assert.equal(first.state, 'paused'); assert.ok(first.gaps.length);
  const wav = f.capture.readAudio(first.id, { startSample: 1598, endSample: 1602 });
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  assert.deepEqual([...new Int16Array(wav.buffer, wav.byteOffset + 44, 4)], [1598, 1599, 2, 3]);
  assert.equal(f.store.allTranscript(f.meeting.id)[0].text, '最后一句');
  const resume = await begin(f, ws, 'resume'); ws.send(pcm); await until(() => f.store.getCommand(resume.id).status === 'done');
  await finish(f, ws, 'end');
  const lines = f.store.allTranscript(f.meeting.id);
  assert.equal(lines.length, 2); assert.notEqual(lines[0].recordingId, lines[1].recordingId);
  assert.equal(lines[1].startSample, 0); assert.equal(lines[1].startMs, 1602 / 16);
  assert.equal(f.store.getMeeting(f.meeting.id).status, 'ended');
});

test('ASR authentication failure preserves PCM and its cause after pause, stop and disconnect', async t => {
  const reason = '语音识别认证失败（HTTP 401），请在连接设置中更新 ASR 凭证';
  const f = await fixture(t, options => {
    options.onState({ asrState: 'error', asrError: reason });
    return { push(buffer, startSample) { options.onGap({ startSample, endSample: startSample + buffer.length / 2, reason }); }, finish: async () => ({ drained: false }), close() {} };
  });
  const ws = await f.connect();
  for (const action of ['pause', 'stop', 'disconnect']) {
    const cmd = await begin(f, ws, action === 'pause' ? 'start' : 'resume');
    const pcm = Buffer.alloc(3200, 7);
    ws.send(pcm); await until(() => f.store.getCommand(cmd.id).status === 'done');
    if (action === 'disconnect') { ws.close(); await once(ws, 'close'); await until(() => !f.capture.getState(f.meeting.id).connected); }
    else await finish(f, ws, action);
    const capture = f.capture.getState(f.meeting.id);
    assert.equal(capture.asrState, 'error');
    assert.equal(capture.asrError, reason);
    const recording = f.store.getRecording(capture.recordingId);
    assert.equal(recording.sampleCount, 1600);
    assert.deepEqual(f.capture.readAudio(recording.id).subarray(44), pcm);
    assert.deepEqual(recording.gaps, [{ startSample: 0, endSample: 1600, reason }]);
  }
});

test('word-level ASR timestamps persist as transcript with playback and correct resume offsets', async t => {
  const f = await fixture(t, options => ({
    push() {},
    async finish() {
      // The live provider can omit the utterance start while returning word times.
      options.onTranscript({ ...normalizeAsrResult({ result: { utterances: [{
        text: '测试尾句', definite: true, end_time: 95, additions: { speaker_id: 0 },
        words: [{ text: '测试', start_time: 40, end_time: 60 }, { text: '尾句', start_time: 60, end_time: 90 }],
      }] } }), epochStartSample: 0 });
    }, close() {},
  }));
  const ws = await f.connect();
  for (const action of ['start', 'resume']) {
    const cmd = await begin(f, ws, action);
    ws.send(Buffer.alloc(3200, 9)); await until(() => f.store.getCommand(cmd.id).status === 'done');
    await finish(f, ws);
  }
  const lines = f.store.allTranscript(f.meeting.id);
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].recordingId, lines[1].recordingId);
  assert.notEqual(lines[0].speakerId, lines[1].speakerId, 'the same upstream number from a resumed connection is a new cluster');
  assert.notEqual(lines[0].participantId, lines[1].participantId);
  for (const [index, line] of lines.entries()) {
    assert.equal(line.text, '测试尾句'); assert.equal(line.origin, 'asr'); assert.match(line.speakerId, /^live-[a-f0-9]+-speaker-0$/);
    assert.equal(line.providerSpeakerId, '0'); assert.ok(line.recognitionSessionId);
    assert.equal(line.startSample, 640); assert.equal(line.endSample, 1520);
    assert.equal(line.startMs, index * 100 + 40); assert.equal(line.endMs, index * 100 + 95);
    assert.deepEqual(f.capture.readAudio(line.recordingId, line).subarray(44), Buffer.alloc(1760, 9));
  }
});

test('commands reflect absent browser, permission denial and browser disconnect', async t => {
  const f = await fixture(t);
  assert.equal(f.capture.request(f.meeting.id, 'start').status, 'error');
  const ws = await f.connect();
  const denied = f.capture.request(f.meeting.id, 'start');
  ws.send(JSON.stringify({ type: 'failed', commandId: denied.id, message: 'Permission denied' }));
  await until(() => f.store.getCommand(denied.id).status === 'error');
  assert.equal(f.store.listRecordings(f.meeting.id).length, 0);
  const cmd = await begin(f, ws); ws.send(Buffer.alloc(320)); await until(() => f.store.getCommand(cmd.id).status === 'done');
  ws.close(); await once(ws, 'close');
  await until(() => !f.capture.getState(f.meeting.id).connected);
  assert.equal(f.capture.getState(f.meeting.id).state, 'interrupted');
  assert.equal(f.store.listRecordings(f.meeting.id)[0].sampleCount, 160);
  assert.equal(f.store.listRecordings(f.meeting.id)[0].state, 'interrupted');
  assert.equal(f.capture.request(f.meeting.id, 'end').status, 'running');
  await until(() => f.store.getMeeting(f.meeting.id).status === 'ended');
});

test('ASR reconnect epoch maps utterances to saved samples and human corrections survive', async t => {
  const f = await fixture(t), ws = await f.connect();
  await begin(f, ws);
  for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(32000));
  await until(() => f.store.listRecordings(f.meeting.id)[0].sampleCount === 48000);
  f.sessions[0].onTranscript({ epochStartSample: 32000, utterances: [{ text: '恢复后的第一句', startTime: 0, endTime: 500, definite: true, speaker: '2' }] });
  const line = f.store.allTranscript(f.meeting.id)[0];
  assert.equal(line.startSample, 32000); assert.equal(line.endSample, 40000); assert.equal(line.startMs, 2000);
  assert.match(line.speakerId, /^live-[a-f0-9]+-speaker-2$/);
  f.store.editTranscript(f.meeting.id, line.id, { text: '主持人修正', speakerId: 'host' });
  f.sessions[0].onTranscript({ epochStartSample: 32000, utterances: [{ text: 'ASR迟到修正', startTime: 0, endTime: 700, definite: true, speaker: '2' }] });
  assert.equal(f.store.allTranscript(f.meeting.id)[0].text, '主持人修正');
  await finish(f, ws, 'stop');
});

test('speaker clusters remain stable within an ASR connection and isolated after reconnect', async t => {
  const f = await fixture(t), ws = await f.connect();
  await begin(f, ws);
  for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(32000));
  await until(() => f.store.listRecordings(f.meeting.id)[0].sampleCount === 48000);
  const emit = (session, epochStartSample, startTime, text = '同一人的发言') => f.sessions[0].onTranscript({ recognitionSessionId: session, epochStartSample, utterances: [{ text, startTime, endTime: startTime + 200, definite: true, speaker: '2' }] });
  emit('first-connection', 0, 0);
  emit('first-connection', 0, 300);
  emit('second-connection', 32000, 0);
  const lines = f.store.allTranscript(f.meeting.id);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].speakerId, lines[1].speakerId);
  assert.equal(lines[0].participantId, lines[1].participantId);
  assert.notEqual(lines[0].speakerId, lines[2].speakerId);
  assert.notEqual(lines[0].participantId, lines[2].participantId);
  const { participant } = f.store.createParticipant(f.meeting.id, { name: '孙总' });
  f.store.assignTranscriptParticipant(f.meeting.id, lines[0].id, participant.id);
  emit('first-connection', 0, 0, '定稿修正后的发言');
  const corrected = f.store.allTranscript(f.meeting.id)[0];
  assert.equal(corrected.text, '定稿修正后的发言');
  assert.equal(corrected.participantId, participant.id, 'a late ASR result can revise words but not a manual attribution');
  assert.equal(corrected.speakerId, lines[0].speakerId);
  await finish(f, ws, 'stop');
});

test('resampler preserves total duration across arbitrary worklet batches and flush', () => {
  for (const rate of [16000, 44100, 48000]) {
    const input = new Float32Array(rate).fill(0.5), resampler = new PCMResampler(rate);
    let bytes = 0;
    for (let start = 0; start < input.length; start += 2048) bytes += resampler.push(input.slice(start, start + 2048)).byteLength;
    bytes += resampler.push(new Float32Array(0), true).byteLength;
    assert.equal(bytes / 2, 16000, `one second at ${rate} Hz remains one second`);
  }
});

test('WebSocket rejects non-local origins', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/capture?meetingId=${f.meeting.id}`, { origin: 'https://untrusted.example' });
  const [error] = await once(ws, 'error'); assert.match(error.message, /403/);
  assert.equal(f.capture.getState(f.meeting.id).connected, false);
});

test('audio worklet flush preserves the short batch before its drain acknowledgement', () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor: (_name, value) => { Processor = value; }, Float32Array,
  });
  const processor = new Processor();
  processor.process([[new Float32Array(128).fill(0.5)]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages[0].type, 'audio'); assert.equal(messages[0].chunk.length, 128);
  assert.equal(messages[1].type, 'flushed');
  processor.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(messages.length, 2, 'no new PCM after flush marker');
});

async function sendAndSync(ws, message) {
  const received = [];
  const listener = raw => received.push(JSON.parse(raw.toString()));
  ws.on('message', listener);
  ws.send(JSON.stringify(message)); ws.send(JSON.stringify({ type: 'ping' }));
  await until(() => received.some(item => item.type === 'pong'));
  ws.off('message', listener);
  return received;
}

test('idle or stopped browser transport failures do not become persisted recording failures', async t => {
  const f = await fixture(t), ws = await f.connect();
  await sendAndSync(ws, { type: 'failed', message: '录音保存连接中断，请重新打开会议并授权' });
  assert.equal(f.store.getMeeting(f.meeting.id).capture.error, null);
  assert.equal(f.capture.getState(f.meeting.id).state, 'idle');
  assert.equal(f.store.listRecordings(f.meeting.id).length, 0);
  const cmd = await begin(f, ws); ws.send(Buffer.alloc(320)); await until(() => f.store.getCommand(cmd.id).status === 'done');
  await finish(f, ws, 'stop');
  await sendAndSync(ws, { type: 'failed', message: 'late callback after audio stopped' });
  assert.equal(f.capture.getState(f.meeting.id).state, 'idle');
  assert.equal(f.capture.getState(f.meeting.id).error, null);
  assert.equal(f.store.listRecordings(f.meeting.id)[0].state, 'stopped');
  assert.equal(f.store.listRecordings(f.meeting.id)[0].sampleCount, 160);
});

test('imported meetings ignore legacy live-capture alerts without changing saved data or playback', async t => {
  const f = await fixture(t);
  const legacy = { connected: true, state: 'idle', recordingId: null, asrState: 'stopped', error: '录音保存连接中断，请重新打开会议并授权' };
  f.store.updateMeeting(f.meeting.id, { source: 'recording_import', status: 'ended', capture: legacy });
  const recording = f.store.createRecording(f.meeting.id, { state: 'stopped', sampleCount: 4, source: 'recording_import' });
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  fs.writeFileSync(path.join(f.store.dataDir, 'audio', `${recording.id}.pcm`), pcm);
  const before = f.store.getMeeting(f.meeting.id);
  assert.equal(f.capture.getState(f.meeting.id).error, null);
  assert.equal(f.capture.getState(f.meeting.id).connected, false);
  assert.equal(f.capture.getState(f.meeting.id).state, 'idle');
  const ws = await f.connect();
  await sendAndSync(ws, { type: 'failed', message: legacy.error });
  ws.close(); await once(ws, 'close'); await until(() => !f.capture.getState(f.meeting.id).connected);
  assert.deepEqual(f.store.getMeeting(f.meeting.id), before, 'reading and reconnecting do not erase or rewrite persisted history');
  assert.deepEqual(f.capture.readAudio(recording.id).subarray(44), pcm);
  assert.equal(f.store.getRecording(recording.id).state, 'stopped');
  assert.equal(f.capture.request(f.meeting.id, 'start').status, 'error');
  assert.equal(f.capture.request(f.meeting.id, 'end').status, 'done', 'ending an already ended meeting is idempotent');
});

test('actual browser capture failure still interrupts recording and retains received PCM', async t => {
  const f = await fixture(t), ws = await f.connect();
  const cmd = await begin(f, ws); ws.send(Buffer.alloc(320)); await until(() => f.store.getCommand(cmd.id).status === 'done');
  await sendAndSync(ws, { type: 'failed', message: '音频保存连接拥堵或断开，录音已停止' });
  assert.equal(f.capture.getState(f.meeting.id).state, 'interrupted');
  assert.match(f.capture.getState(f.meeting.id).error, /音频保存连接拥堵/);
  const recording = f.store.listRecordings(f.meeting.id)[0];
  assert.equal(recording.state, 'interrupted'); assert.equal(recording.sampleCount, 160);
  assert.equal(f.capture.readAudio(recording.id).length, 364);
});
