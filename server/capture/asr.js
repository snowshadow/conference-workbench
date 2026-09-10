import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { assertOutboundUrl, createSafeLookup, loadOutboundPolicy } from './outbound-url.js';
import { buildAsrHeaders, buildFullClientRequest, buildAudioRequest, parseServerMessage, normalizeAsrResult } from './protocol.js';

// A fresh upstream connection is a fresh ASR clock. Its first PCM sample is
// recorded explicitly; reconnects never reuse the previous connection's clock.
export function createASRSession({ config, onState, onTranscript, onGap }) {
  let socket, retry, closed = false, finishing = false, finishResolve, finishTimer, finishPromise;
  let pending = [], pendingBytes = 0, epoch = null, lastSample = 0, lastFinalSample = 0;
  let lastError = null, terminalError = null, terminalGapThrough = 0, finishResult = { drained: false };
  const configured = Boolean(config.apiKey || (config.appKey && config.accessKey));
  const notify = (state, error = null) => onState({ asrState: state, asrError: error });
  const gap = (start, end, reason) => { if (end > start) onGap({ startSample: start, endSample: end, reason }); };

  function connect() {
    if (closed || finishing || terminalError) return;
    epoch = { id: randomUUID(), startSample: null, sentThrough: lastSample };
    const current = epoch;
    notify(lastSample ? 'reconnecting' : 'connecting');
    try {
      const url = config.url || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
      const policy = loadOutboundPolicy();
      assertOutboundUrl(url, policy, { protocols: ['wss:', 'ws:'], label: 'ASR 地址' });
      socket = new WebSocket(url, {
        headers: buildAsrHeaders({ ...config, resourceId: config.resourceId || 'volc.seedasr.sauc.duration' }, current.id),
        lookup: createSafeLookup(policy), maxPayload: 1_048_576, handshakeTimeout: 10_000,
      });
      const ws = socket;
      ws.on('open', () => {
        if (closed || epoch !== current || current.failed) return;
        try {
          ws.send(buildFullClientRequest());
          lastError = null;
          notify('connected');
          for (const item of pending) send(item, current, ws);
          pending = []; pendingBytes = 0;
          if (finishing) ws.send(buildAudioRequest(Buffer.alloc(0), true));
        } catch { fail(current, '语音识别发送失败，录音继续保存'); }
      });
      ws.on('unexpected-response', (_request, response) => {
        // Do not expose the upstream body: gateways may echo credentials or
        // request contents. The HTTP status gives a useful, safe diagnosis.
        const failure = handshakeFailure(response.statusCode);
        fail(current, failure.message, failure.retryable);
        response.destroy();
      });
      ws.on('message', data => {
        if (closed || epoch !== current || current.failed) return;
        try {
          const message = parseServerMessage(Buffer.from(data));
          if (message.type === 'error') {
            const failure = protocolFailure(message.code);
            fail(current, failure.message, failure.retryable);
            return;
          }
          if (message.type !== 'response') return;
          const final = Boolean((message.flags & 2) || message.sequence < 0);
          const result = normalizeAsrResult(message.payload);
          if (finishing && final) result.utterances.forEach(line => { line.definite = true; });
          for (const line of result.utterances) {
            if (line.definite && Number.isFinite(line.endTime)) {
              lastFinalSample = Math.max(lastFinalSample, (current.startSample || 0) + Math.round(line.endTime * 16));
            }
          }
          onTranscript({ ...result, epochStartSample: current.startSample || 0, recognitionSessionId: current.id });
          if (final) {
            if (finishing) complete(true);
            else fail(current, '语音识别连接已结束，正在重新连接');
          }
        } catch { fail(current, '语音识别响应无效，正在重新连接'); }
      });
      ws.on('error', () => fail(current, '语音识别连接异常，录音继续保存'));
      ws.on('close', code => {
        if (closed || epoch !== current || current.failed) return;
        if (finishing) complete(false);
        else if ([1002, 1003, 1008].includes(code)) fail(current, `语音识别服务拒绝连接（WebSocket ${code}），请检查 ASR 配置。`, false);
        else fail(current, '语音识别连接中断，录音继续保存');
      });
    } catch { fail(current, '语音识别连接配置无效，请检查 ASR 地址和凭证格式。', false); }
  }
  function send(item, current = epoch, ws = socket) {
    if (current.startSample === null) current.startSample = item.startSample;
    current.sentThrough = item.startSample + item.buffer.length / 2;
    ws.send(buildAudioRequest(item.buffer, false));
  }
  function fail(current, message, retryable = true) {
    if (closed || epoch !== current || current.failed) return;
    current.failed = true;
    lastError = message;
    if (!retryable) {
      terminalError = message;
      clearTimeout(retry);
      // Pending PCM is already on disk. A rejected credential cannot consume
      // it, so record the missing transcript range and release the queue.
      gap(Math.min(lastFinalSample, lastSample), lastSample, message);
      terminalGapThrough = lastSample;
      pending = []; pendingBytes = 0;
    } else if (current.startSample !== null) gap(Math.max(current.startSample, lastFinalSample), current.sentThrough, message);
    notify(finishing || !retryable ? 'error' : 'reconnecting', message);
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (finishing) { complete(false); return; }
    if (!retryable) return;
    retry = setTimeout(connect, 1000);
    retry.unref?.();
  }
  function complete(drained) {
    if (closed) return;
    if (!drained) {
      const reason = lastError || (configured ? '结束时 ASR 未确认尾段，录音可回听' : 'ASR 未配置，录音可回听');
      gap(Math.max(Math.min(lastFinalSample, lastSample), terminalGapThrough), lastSample, reason);
      if (configured) lastError = reason;
    }
    closed = true;
    clearTimeout(retry); clearTimeout(finishTimer);
    pending = []; pendingBytes = 0;
    socket?.terminate();
    notify(configured ? (lastError && !drained ? 'error' : 'stopped') : 'unconfigured', configured && !drained ? lastError : null);
    finishResult = { drained };
    finishResolve?.(finishResult);
  }
  if (configured) connect(); else notify('unconfigured');
  return {
    push(buffer, startSample) {
      if (closed || finishing) return;
      lastSample = startSample + buffer.length / 2;
      if (!configured) return;
      if (terminalError) {
        gap(startSample, lastSample, terminalError);
        terminalGapThrough = lastSample;
        return;
      }
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
      if (closed) return Promise.resolve(finishResult);
      if (finishing) return finishPromise;
      finishing = true;
      clearTimeout(retry);
      finishPromise = new Promise(resolve => {
        finishResolve = resolve;
        if (!configured || terminalError) { complete(false); return; }
        finishTimer = setTimeout(() => complete(false), 5000);
        try {
          if (socket?.readyState === WebSocket.OPEN && !epoch.failed) socket.send(buildAudioRequest(Buffer.alloc(0), true));
          else complete(false);
        } catch { fail(epoch, '语音识别尾段发送失败，录音可回听'); }
      });
      return finishPromise;
    },
    close() { complete(false); },
  };
}

function handshakeFailure(status) {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  if (status === 401) return { retryable: false, message: '实时转录鉴权失败（HTTP 401），请检查火山语音 API Key。' };
  if (status === 403) return { retryable: false, message: '实时转录访问被拒绝（HTTP 403），请检查凭证和语音识别资源权限。' };
  if (status === 404) return { retryable: false, message: '实时转录接口不存在（HTTP 404），请检查 ASR 地址。' };
  return { retryable, message: retryable
    ? `实时转录服务暂不可用（HTTP ${status}），正在重试；录音继续保存。`
    : `实时转录请求被拒绝（HTTP ${status}），请检查 ASR 地址、凭证和资源 ID。` };
}

function protocolFailure(code) {
  if (code === 45000001) return { retryable: false, message: `实时转录请求参数无效（${code}），请检查 ASR 配置。` };
  if (code === 45000151) return { retryable: false, message: `实时转录音频格式不受支持（${code}），录音已保存在本机。` };
  return { retryable: true, message: `语音识别服务返回错误（${code}），正在重试；录音继续保存。` };
}
