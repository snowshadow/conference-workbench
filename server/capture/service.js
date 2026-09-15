import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createASRSession } from './asr.js';

const RATE = 16000;
const ACTIONS = new Set(['start', 'resume', 'pause', 'stop', 'end']);
const loopback = host => ['127.0.0.1', 'localhost', '[::1]', '::1', '::ffff:127.0.0.1'].includes(host);
const problem = message => Object.assign(new Error(message), { status: 409 });
const importedMeeting = meeting => meeting.source === 'recording_import' || Boolean(meeting.importJobId);
const inactiveCapture = () => ({ connected: false, state: 'idle', recordingId: null, asrState: 'stopped', error: null, asrError: null });
const stoppedAsrState = capture => capture.asrError ? 'error' : capture.asrState === 'unconfigured' ? 'unconfigured' : 'stopped';

export function createCaptureService({ server, store, onEnded = () => {}, onTranscript = () => {}, asrFactory = createASRSession }) {
  const hosts = new Map();
  const audioDir = path.join(store.dataDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32000 });
  const send = (host, message) => { if (host.ws?.readyState === WebSocket.OPEN) host.ws.send(JSON.stringify(message)); };

  // A process restart cannot leave a persisted "recording" claim behind.
  for (const meeting of [...store.listMeetings({ archived: false }), ...store.listMeetings({ archived: true })]) {
    for (const recording of store.listRecordings(meeting.id)) {
      if (recording.state === 'recording') {
        const file = path.join(audioDir, `${recording.id}.pcm`);
        const sampleCount = fs.existsSync(file) ? Math.floor(fs.statSync(file).size / 2) : 0;
        store.updateRecording(recording.id, { sampleCount, state: 'interrupted', endedAt: new Date().toISOString(), gaps: [...(recording.gaps || []), { startSample: 0, endSample: sampleCount, reason: '服务重启，未确认的转录请回听' }] });
      }
    }
    if (meeting.capture?.state === 'recording') store.mutateMeeting(meeting.id, draft => { draft.capture = { connected: false, state: 'interrupted', asrState: 'stopped', error: '服务已重启，请重新授权录音' }; });
    for (const cmd of store.listCommands(meeting.id)) if (['running', 'pending', 'needs_user_action'].includes(cmd.status)) store.updateCommand(cmd.id, { status: 'error', error: '服务已重启，请重新发起命令' });
  }
  function getHost(id) {
    const meeting = store.getMeeting(id);
    if (!hosts.has(id)) hosts.set(id, {
      meetingId: id, ws: null, fd: null, recording: null, asr: null, command: null, timer: null, busy: false, lastAudio: 0,
      lines: new Map(), state: importedMeeting(meeting) ? inactiveCapture() : { ...meeting.capture, connected: false },
    });
    return hosts.get(id);
  }
  function state(host, patch) {
    if (importedMeeting(store.getMeeting(host.meetingId))) {
      // File decoding/transcription has its own persistent import job. Historical
      // live-socket errors are irrelevant here; do not rewrite saved meeting data.
      host.state = inactiveCapture();
      send(host, { type: 'state', ...host.state });
      return;
    }
    host.state = { ...host.state, ...patch };
    store.updateMeeting(host.meetingId, { capture: host.state });
    send(host, { type: 'state', ...host.state });
  }
  function command(host, id, patch) {
    const updated = store.updateCommand(id, patch);
    send(host, { type: 'command', command: updated });
    return updated;
  }
  function settle(host, status, error) {
    clearTimeout(host.timer); host.timer = null;
    if (host.command) command(host, host.command.id, { status, ...(error ? { error } : { result: { ...host.state } }) });
    host.command = null;
  }
  function request(meetingId, action) {
    if (!ACTIONS.has(action)) throw Object.assign(new Error('不支持的录音操作'), { status: 400 });
    const host = getHost(meetingId);
    const result = store.createCommand(meetingId, action);
    const fail = error => command(host, result.id, { status: 'error', error });
    if (['stop', 'end'].includes(action) && host.fd === null && ['start', 'resume'].includes(host.command?.action)) settle(host, 'error', '录音授权已取消');
    if (host.command || host.busy) return fail('另一个录音命令正在执行');
    const meeting = store.getMeeting(meetingId);
    if (importedMeeting(meeting) && action !== 'end') return fail('导入会议不使用实时录音，请查看录音导入进度。');
    if (meeting.status === 'ended' && action !== 'end') return fail('会议已结束');
    if (meeting.status === 'ended' && action === 'end') return command(host, result.id, { status: 'done', result: { ...host.state } });
    if (action === 'stop' && host.fd === null) {
      if (host.recording?.state === 'paused') host.recording = store.updateRecording(host.recording.id, { state: 'stopped' });
      state(host, { state: 'idle' });
      return command(host, result.id, { status: 'done', result: { ...host.state } });
    }
    if (action === 'end' && host.fd === null) {
      host.command = result; host.busy = true;
      command(host, result.id, { status: 'running' });
      Promise.resolve().then(() => onEnded(meetingId)).then(() => {
        state(host, { state: 'idle' }); settle(host, 'done');
      }, error => settle(host, 'error', error.message)).finally(() => { host.busy = false; });
      return store.getCommand(result.id);
    }
    if (!host.ws || host.ws.readyState !== WebSocket.OPEN) return fail('主持人页面未连接，请打开本场会议');
    if (['start', 'resume'].includes(action)) {
      if (host.fd !== null || host.state.state === 'recording') return fail('本场会议已经在录音');
      if ([...hosts.values()].some(other => other !== host && (other.fd !== null || ['start', 'resume'].includes(other.command?.action)))) return fail('另一场会议正在录音或等待录音授权');
      host.command = result;
      return command(host, result.id, { status: 'needs_user_action' });
    }
    if (host.fd === null) return fail('当前没有正在采集的录音');
    host.command = result;
    host.timer = setTimeout(() => interrupt(host, '浏览器未完成音频尾段保存'), 12_000);
    return command(host, result.id, { status: 'running' });
  }

  function addGap(host, gap) {
    if (!host.recording || gap.endSample <= gap.startSample) return;
    const recording = store.getRecording(host.recording.id);
    const gaps = [...(recording.gaps || [])];
    const last = gaps.at(-1);
    if (last && last.reason === gap.reason && last.endSample >= gap.startSample) last.endSample = Math.max(last.endSample, gap.endSample);
    else gaps.push(gap);
    host.recording = store.updateRecording(recording.id, { gaps });
  }
  function transcript(host, result) {
    if (!host.recording) return;
    const rec = host.recording;
    let changed = false;
    let partial = result.utterances?.length ? '' : result.text || '';
    for (const line of result.utterances || []) {
      if (!line.definite) { partial += line.text || ''; continue; }
      if (!line.text?.trim() || !Number.isFinite(line.startTime) || !Number.isFinite(line.endTime)) continue;
      const startSample = Math.max(0, Math.min(rec.sampleCount, result.epochStartSample + Math.round(line.startTime * 16)));
      const endSample = Math.max(startSample, Math.min(rec.sampleCount, result.epochStartSample + Math.round(line.endTime * 16)));
      const recognitionSessionId = result.recognitionSessionId || `${rec.id}:${result.epochStartSample}`;
      const providerSpeakerId = line.speaker === '' || line.speaker === undefined || line.speaker === null ? '' : String(line.speaker);
      // Upstream diarization numbers only identify a cluster in one connection.
      // Include the recording and ASR session, including after pause/reconnect.
      const scope = createHash('sha256').update(`${rec.id}:${recognitionSessionId}`).digest('hex').slice(0, 20);
      const speakerId = providerSpeakerId ? `live-${scope}-speaker-${providerSpeakerId.slice(0, 60)}` : 'unknown';
      const input = { recordingId: rec.id, text: line.text.trim(), speakerId, recognitionSessionId, providerSpeakerId, startSample, endSample, startMs: rec.timelineStartMs + startSample / 16, endMs: rec.timelineStartMs + endSample / 16, origin: 'asr' };
      const key = `${recognitionSessionId}:${line.startTime}`;
      const previous = host.lines.get(key);
      if (previous) {
        const current = store.allTranscript(host.meetingId).find(item => item.id === previous.id);
        if (current?.origin === 'asr' && (current.text !== input.text || current.speakerId !== speakerId || current.endSample !== endSample)) {
          const next = store.editTranscript(host.meetingId, previous.id, { ...input, origin: 'asr' });
          host.lines.set(key, next);
          changed = true;
        }
      } else { host.lines.set(key, store.appendTranscript(host.meetingId, input)); changed = true; }
    }
    send(host, { type: 'partial', text: partial });
    if (changed) Promise.resolve().then(() => onTranscript(host.meetingId)).catch(() => {});
  }
  function begin(host, commandId) {
    const meeting = store.getMeeting(host.meetingId);
    if (meeting.status === 'ended' || importedMeeting(meeting)) throw problem('本场会议不再接受实时录音');
    if (!host.command || host.command.id !== commandId || !['start', 'resume'].includes(host.command.action)) throw problem('录音授权命令已失效');
    if (host.fd !== null) throw problem('录音已经开始');
    const recordings = store.listRecordings(host.meetingId);
    const timelineStartMs = Math.max(0, ...recordings.map(item => item.timelineStartMs + item.sampleCount / 16));
    host.recording = store.createRecording(host.meetingId, { timelineStartMs });
    host.fd = fs.openSync(path.join(audioDir, `${host.recording.id}.pcm`), 'wx', 0o600);
    host.lines.clear();
    command(host, commandId, { status: 'running' });
    state(host, { recordingId: host.recording.id, error: null, asrError: null });
    host.asr = asrFactory({ config: store.getSettings().asr || {},
      onState: patch => state(host, patch),
      onTranscript: result => transcript(host, result),
      onGap: gap => addGap(host, gap),
    });
    host.lastAudio = Date.now();
    host.timer = setTimeout(() => interrupt(host, '未收到麦克风音频，请检查输入设备和权限'), 12_000);
    send(host, { type: 'ready', commandId, recordingId: host.recording.id });
  }
  function audio(host, buffer) {
    if (host.fd === null || host.busy || !buffer.length || buffer.length % 2) throw problem('音频帧无效或当前没有录音');
    const startSample = host.recording.sampleCount;
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(host.fd, buffer, offset, buffer.length - offset);
    host.recording = store.updateRecording(host.recording.id, { sampleCount: startSample + buffer.length / 2 });
    host.lastAudio = Date.now();
    if (host.state.state !== 'recording') {
      store.updateMeeting(host.meetingId, { status: 'active' });
      state(host, { state: 'recording', error: null });
      settle(host, 'done');
    }
    // PCM is already on disk before it is offered to the ASR provider.
    try { host.asr?.push(buffer, startSample); } catch { state(host, { asrState: 'error', asrError: '语音识别异常，录音继续保存' }); addGap(host, { startSample, endSample: host.recording.sampleCount, reason: 'ASR 发送失败，录音可回听' }); }
    send(host, { type: 'saved', sampleCount: host.recording.sampleCount });
  }
  async function drain(host, commandId) {
    if (host.command?.id !== commandId || !['pause', 'stop', 'end'].includes(host.command.action)) throw problem('停止命令已失效');
    host.busy = true;
    const action = host.command.action;
    clearTimeout(host.timer);
    fs.fdatasyncSync(host.fd);
    await host.asr?.finish();
    if (host.fd === null) { host.busy = false; return; }
    fs.closeSync(host.fd); host.fd = null; host.asr = null;
    host.recording = store.updateRecording(host.recording.id, { state: action === 'pause' ? 'paused' : 'stopped', endedAt: new Date().toISOString() });
    state(host, { state: action === 'pause' ? 'paused' : 'idle', asrState: stoppedAsrState(host.state) });
    send(host, { type: 'partial', text: '' });
    try { if (action === 'end') await onEnded(host.meetingId); settle(host, 'done'); }
    catch (error) { settle(host, 'error', error.message); }
    finally { host.busy = false; }
  }
  function interrupt(host, error) {
    if (host.fd === null && !host.command) return;
    clearTimeout(host.timer);
    host.busy = false;
    host.asr?.close(); host.asr = null;
    if (host.fd !== null) {
      try { fs.fdatasyncSync(host.fd); } catch { /* preserve original storage error */ }
      fs.closeSync(host.fd); host.fd = null;
    }
    if (host.recording?.state === 'recording') host.recording = store.updateRecording(host.recording.id, { state: 'interrupted', endedAt: new Date().toISOString() });
    state(host, { state: 'interrupted', error, asrState: stoppedAsrState(host.state) });
    settle(host, 'error', error);
    send(host, { type: 'interrupted', message: error });
  }
  function upgrade(req, socket, head) {
    let url, origin;
    try {
      url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/capture') return;
      origin = new URL(req.headers.origin);
      const requestHost = new URL(`http://${req.headers.host}`);
      const ports = ['5187', '8797', String(server.address()?.port)];
      if (!loopback(req.socket.remoteAddress) || !loopback(requestHost.hostname) || !loopback(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || !ports.includes(origin.port)) throw new Error();
      const host = getHost(url.searchParams.get('meetingId'));
      if (host.ws?.readyState === WebSocket.OPEN) { socket.end('HTTP/1.1 409 Conflict\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        host.ws = ws;
        state(host, { connected: true });
        ws.on('message', (data, binary) => {
          try {
            if (binary) { audio(host, Buffer.from(data)); return; }
            const message = JSON.parse(data.toString());
            if (message.type === 'begin') begin(host, message.commandId);
            else if (message.type === 'drained') drain(host, message.commandId).catch(error => interrupt(host, error.message));
            else if (message.type === 'failed') {
              if (message.commandId && message.commandId !== host.command?.id) return;
              if (host.fd === null && !host.command) return;
              if (host.fd !== null) interrupt(host, String(message.message || '浏览器采集失败').slice(0, 300));
              else { settle(host, 'error', String(message.message || '音频授权失败').slice(0, 300)); state(host, { error: String(message.message || '音频授权失败').slice(0, 300) }); }
            } else if (message.type === 'ping') send(host, { type: 'pong' });
          } catch (error) { interrupt(host, error.message); }
        });
        ws.on('close', () => {
          if (host.ws !== ws) return;
          host.ws = null;
          if (host.fd !== null || host.command) interrupt(host, '主持人页面连接已断开，录音已停止');
          state(host, { connected: false });
        });
        ws.on('error', () => ws.close());
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  }
  server.on('upgrade', upgrade);
  const watchdog = setInterval(() => {
    for (const host of hosts.values()) if (host.fd !== null && !host.busy && Date.now() - host.lastAudio > 15_000) interrupt(host, '浏览器音频采集已中断，请重新授权录音');
  }, 5000);
  watchdog.unref();
  return {
    request,
    getState(meetingId) { return importedMeeting(store.getMeeting(meetingId)) ? inactiveCapture() : { ...getHost(meetingId).state }; },
    readAudio(recordingId, { startSample = 0, endSample } = {}) {
      const recording = store.getRecording(recordingId);
      const start = Number(startSample), end = endSample === undefined ? recording.sampleCount : Number(endSample);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > recording.sampleCount) throw Object.assign(new Error('音频区间无效'), { status: 400 });
      if (end - start > RATE * 60 * 60) throw Object.assign(new Error('每次回听最多一小时，请缩小音频区间'), { status: 400 });
      const samples = Buffer.alloc((end - start) * 2);
      const fd = fs.openSync(path.join(audioDir, `${recordingId}.pcm`), 'r');
      try { const bytes = fs.readSync(fd, samples, 0, samples.length, start * 2); if (bytes !== samples.length) throw new Error('录音文件不完整'); }
      finally { fs.closeSync(fd); }
      return wav(samples);
    },
    close() {
      clearInterval(watchdog); server.off('upgrade', upgrade);
      for (const host of hosts.values()) {
        if (host.fd !== null || host.command) interrupt(host, '录音服务已关闭');
        const ws = host.ws; host.ws = null; ws?.terminate();
      }
      wss.close();
    },
  };
}

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
