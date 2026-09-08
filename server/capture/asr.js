import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { assertOutboundUrl, createSafeLookup, loadOutboundPolicy } from './outbound-url.js';
import { buildAsrHeaders, buildFullClientRequest, buildAudioRequest, parseServerMessage, normalizeAsrResult } from './protocol.js';

// A fresh upstream connection is a fresh ASR clock. Its first PCM sample is
// recorded explicitly; reconnects never reuse the previous connection's clock.
export function createASRSession({ config, onState, onTranscript, onGap }) {
  let socket, retry, closed = false, finishing = false, finishResolve, finishTimer;
  let pending = [], pendingBytes = 0, epoch = null, lastSample = 0, lastFinalSample = 0;
  const configured = Boolean(config.apiKey || (config.appKey && config.accessKey));
  const notify = (state, error = null) => onState({ asrState: state, asrError: error });
  const gap = (start, end, reason) => { if (end > start) onGap({ startSample: start, endSample: end, reason }); };

  function connect() {
    if (closed || finishing) return;
    epoch = { startSample: null, sentThrough: lastSample };
    const current = epoch;
    notify(lastSample ? 'reconnecting' : 'connecting');
    try {
      const url = config.url || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
      const policy = loadOutboundPolicy();
      assertOutboundUrl(url, policy, { protocols: ['wss:', 'ws:'], label: 'ASR 地址' });
      socket = new WebSocket(url, {
        headers: buildAsrHeaders({ ...config, resourceId: config.resourceId || 'volc.seedasr.sauc.duration' }, randomUUID()),
        lookup: createSafeLookup(policy), maxPayload: 1_048_576, handshakeTimeout: 10_000,
      });
      const ws = socket;
      ws.on('open', () => {
        if (closed || epoch !== current) return;
        ws.send(buildFullClientRequest());
        notify('connected');
        for (const item of pending) send(item, current, ws);
        pending = []; pendingBytes = 0;
        if (finishing) ws.send(buildAudioRequest(Buffer.alloc(0), true));
      });
      ws.on('message', data => {
        if (closed || epoch !== current) return;
        try {
          const message = parseServerMessage(Buffer.from(data));
          if (message.type === 'error') { fail(current, '语音识别服务返回错误，请检查 ASR 配置'); return; }
          if (message.type !== 'response') return;
          const final = Boolean((message.flags & 2) || message.sequence < 0);
          const result = normalizeAsrResult(message.payload);
          if (finishing && final) result.utterances.forEach(line => { line.definite = true; });
          for (const line of result.utterances) {
            if (line.definite && Number.isFinite(line.endTime)) {
              lastFinalSample = Math.max(lastFinalSample, (current.startSample || 0) + Math.round(line.endTime * 16));
            }
          }
          onTranscript({ ...result, epochStartSample: current.startSample || 0 });
          if (final) {
            if (finishing) complete(true);
            else fail(current, '语音识别连接已结束，正在重新连接');
          }
        } catch { fail(current, '语音识别响应无效，正在重新连接'); }
      });
      ws.on('error', () => fail(current, '语音识别连接异常，录音继续保存'));
      ws.on('close', () => { if (finishing) complete(false); else fail(current, '语音识别连接中断，录音继续保存'); });
    } catch (error) { fail(current, error.message); }
  }
  function send(item, current = epoch, ws = socket) {
    if (current.startSample === null) current.startSample = item.startSample;
    current.sentThrough = item.startSample + item.buffer.length / 2;
    ws.send(buildAudioRequest(item.buffer, false));
  }
  function fail(current, message) {
    if (closed || epoch !== current || current.failed) return;
    current.failed = true;
    gap(Math.max(current.startSample || 0, lastFinalSample), current.sentThrough, message);
    notify(finishing ? 'error' : 'reconnecting', message);
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (finishing) { complete(false); return; }
    retry = setTimeout(connect, 1000);
    retry.unref?.();
  }
  function complete(drained) {
    if (closed) return;
    if (!drained) gap(Math.min(lastFinalSample, lastSample), lastSample, configured ? '结束时 ASR 未确认尾段，录音可回听' : 'ASR 未配置，录音可回听');
    closed = true;
    clearTimeout(retry); clearTimeout(finishTimer);
    socket?.terminate();
    notify(configured ? 'stopped' : 'unconfigured');
    finishResolve?.({ drained });
  }
  if (configured) connect(); else notify('unconfigured');
  return {
    push(buffer, startSample) {
      if (closed || finishing) return;
      lastSample = startSample + buffer.length / 2;
      if (!configured) return;
      const item = { buffer, startSample };
      if (socket?.readyState === WebSocket.OPEN && !epoch.failed) send(item);
      else {
        pending.push(item); pendingBytes += buffer.length;
        while (pendingBytes > 16_000 * 2 * 8) {
          const dropped = pending.shift(); pendingBytes -= dropped.buffer.length;
          gap(dropped.startSample, dropped.startSample + dropped.buffer.length / 2, 'ASR 连接等待超时，录音可回听');
        }
      }
    },
    finish() {
      if (closed) return Promise.resolve({ drained: false });
      finishing = true;
      clearTimeout(retry);
      return new Promise(resolve => {
        finishResolve = resolve;
        if (!configured) { complete(false); return; }
        finishTimer = setTimeout(() => complete(false), 5000);
        if (socket?.readyState === WebSocket.OPEN && !epoch.failed) socket.send(buildAudioRequest(Buffer.alloc(0), true));
        else complete(false);
      });
    },
    close() { complete(false); },
  };
}
