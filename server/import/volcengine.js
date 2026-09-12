import { randomUUID } from 'node:crypto';
import { normalizeAsrResult } from '../capture/protocol.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
export const VOLC_FILE_LIMITS = Object.freeze({ maxAudioBytes: 100_000_000, maxDurationSeconds: 7200 });
const MAX_RESPONSE_BYTES = 16 * 1024 ** 2;

class VolcFileError extends Error {}

function problem(publicMessage, code, { logId, status = 502 } = {}) {
  const error = new VolcFileError(publicMessage);
  error.publicMessage = publicMessage;
  error.code = code;
  error.status = status;
  if (logId) error.logId = logId;
  return error;
}

function headersFor(config) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Api-Resource-Id': config.resourceId || 'volc.bigasr.auc_turbo',
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1',
  };
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) headers['X-Api-Key'] = config.apiKey.trim();
  else if (typeof config.appKey === 'string' && config.appKey.trim() && typeof config.accessKey === 'string' && config.accessKey.trim()) {
    headers['X-Api-App-Key'] = config.appKey.trim();
    headers['X-Api-Access-Key'] = config.accessKey.trim();
  } else throw problem('请先配置火山引擎的文件转录凭证。', 'ASR_NOT_CONFIGURED', { status: 400 });
  return headers;
}

function diagnostics(response, config) {
  const rawCode = response.headers.get('X-Api-Status-Code') || '';
  const rawLogId = response.headers.get('X-Tt-Logid') || '';
  const secrets = [config.apiKey, config.appKey, config.accessKey].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  const safe = value => !secrets.some(secret => value.includes(secret));
  return {
    code: /^\d{8}$/.test(rawCode) && safe(rawCode) ? rawCode : undefined,
    logId: /^[a-zA-Z0-9_-]{1,128}$/.test(rawLogId) && safe(rawLogId) ? rawLogId : undefined,
  };
}

function serviceProblem(response, code, logId) {
  const httpMessages = {
    401: '火山文件转录认证失败，请检查 API Key。',
    403: '火山文件转录未获授权，请检查凭证并开通录音文件极速版权限。',
    413: '火山文件转录拒绝了过大的音频，请缩短转录分段。',
    429: '火山文件转录暂时繁忙，请稍后重试。',
  };
  const codeMessages = {
    '45000001': '火山文件转录请求参数无效，请检查配置后重试。',
    '45000002': '火山文件转录收到空音频，原始录音已保留。',
    '45000131': '火山文件转录提交量达到限制，请稍后重试。',
    '45000132': '火山文件转录音频超过大小限制，请缩短转录分段。',
    '45000151': '火山文件转录不支持这段音频的格式，原始录音已保留。',
    '55000031': '火山文件转录服务繁忙，请稍后重试。',
  };
  const message = httpMessages[response.status] || codeMessages[code] || '火山文件转录处理失败，录音已保留，可重试。';
  return problem(message, code && !['20000000', '20000003'].includes(code) ? code : `HTTP_${response.status}`, { logId });
}

function durationOf(payload) {
  const result = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
  const candidates = [payload?.audio_info?.duration, result?.additions?.duration];
  for (const value of candidates) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function normalizeResult(payload, logId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('火山文件转录返回了无法识别的结果，请重试。', 'ASR_INVALID_RESPONSE', { logId });
  const results = Array.isArray(payload.result) ? payload.result : [payload.result];
  if (!results.length || results.some(result => !result || typeof result !== 'object' ||
    (result.text !== undefined && typeof result.text !== 'string') ||
    (typeof result.text !== 'string' && !Array.isArray(result.utterances)) ||
    (Array.isArray(result.utterances) && result.utterances.some(item => !item || typeof item !== 'object')))) {
    throw problem('火山文件转录未返回转录文本，请重试。', 'ASR_INVALID_RESPONSE', { logId });
  }
  const normalized = results.map(result => normalizeAsrResult({ result }));
  const utterances = normalized.flatMap(result => result.utterances).filter(item => typeof item.text === 'string' && item.text.trim());
  const text = results.map((result, index) => typeof result.text === 'string' && result.text.trim()
    ? result.text.trim()
    : normalized[index].utterances.map(item => typeof item.text === 'string' ? item.text.trim() : '').filter(Boolean).join(' ')).filter(Boolean).join(' ');
  const durationMs = durationOf(payload);
  const segmentText = utterances.map(item => item.text.trim()).join(' ');
  const valid = utterances.length > 0 && text.replace(/\s/g, '') === segmentText.replace(/\s/g, '') && utterances.every(item =>
    Number.isFinite(item.startTime) && Number.isFinite(item.endTime) && item.startTime >= 0 && item.endTime > item.startTime &&
    (durationMs === undefined || item.endTime <= durationMs + 100));
  // Preserve the full transcript if a sentence cannot be located. The import
  // service will use the known chunk duration and mark its timing approximate.
  const segments = valid ? utterances.map(item => ({
    text: item.text.trim(), start: item.startTime / 1000, end: item.endTime / 1000,
    ...(((typeof item.speaker === 'string' && item.speaker.trim()) || Number.isFinite(item.speaker)) ? { speaker_id: item.speaker } : {}),
  })) : [];
  return { text, segments, ...(durationMs === undefined ? {} : { durationMs }) };
}

/** Transcribe one WAV chunk; speaker IDs belong only to this request. */
export async function transcribeVolcAudio({ audio, config = {}, signal, fetchImpl = globalThis.fetch, requestTimeoutMs = 300000 }) {
  if (signal?.aborted) {
    const error = problem('文件转录已取消，录音已保留。', 'ASR_ABORTED'); error.name = 'AbortError'; throw error;
  }
  if (!Buffer.isBuffer(audio) || !audio.length) throw problem('文件转录需要非空音频。', 'ASR_EMPTY_AUDIO', { status: 400 });
  if (audio.length > VOLC_FILE_LIMITS.maxAudioBytes) throw problem('火山文件转录单段音频不能超过 100 MB。', 'ASR_AUDIO_TOO_LARGE', { status: 413 });
  const headers = headersFor(config);
  const controller = new AbortController();
  let timedOut = false, response, reader;
  const cancelBody = () => { try { const cancelled = reader ? reader.cancel() : response?.body?.cancel(); cancelled?.catch(() => {}); } catch { /* Cancellation must not obscure the useful error. */ } };
  const forwardAbort = () => controller.abort();
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    cancelBody();
    const error = timedOut
      ? problem('火山文件转录超时，录音和已完成的转录会保留，请重试。', 'ASR_TIMEOUT')
      : problem('文件转录已取消，录音已保留。', 'ASR_ABORTED');
    if (!timedOut) error.name = 'AbortError';
    rejectAbort(error);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 300000;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  async function request() {
    if (controller.signal.aborted) return aborted;
    response = await fetchImpl(ENDPOINT, {
      method: 'POST', headers, signal: controller.signal, redirect: 'error',
      body: JSON.stringify({ user: { uid: 'meeting-workbench' }, audio: { data: audio.toString('base64'), format: 'wav' }, request: {
        model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false,
        show_utterances: true, enable_speaker_info: true,
      } }),
    });
    if (controller.signal.aborted) { cancelBody(); return aborted; }
    const { code, logId } = diagnostics(response, config);
    if (!response.ok || (code && !['20000000', '20000003'].includes(code))) {
      cancelBody(); throw serviceProblem(response, code, logId);
    }
    if (!code) { cancelBody(); throw problem('火山文件转录未返回有效的处理状态，请重试。', 'ASR_INVALID_RESPONSE', { logId }); }
    if (code === '20000003') { cancelBody(); return { text: '', segments: [], noSpeech: true }; }
    const declaredSize = Number(response.headers.get('Content-Length'));
    if (declaredSize > MAX_RESPONSE_BYTES) { cancelBody(); throw problem('火山文件转录结果过大，请缩短分段后重试。', 'ASR_RESPONSE_TOO_LARGE', { logId }); }
    if (!response.body) throw problem('火山文件转录返回了空结果，请重试。', 'ASR_INVALID_RESPONSE', { logId });
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (controller.signal.aborted) return aborted;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancelBody(); throw problem('火山文件转录结果过大，请缩短分段后重试。', 'ASR_RESPONSE_TOO_LARGE', { logId }); }
      chunks.push(Buffer.from(value));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw problem('火山文件转录返回了无法识别的结果，请重试。', 'ASR_INVALID_RESPONSE', { logId }); }
    return normalizeResult(payload, logId);
  }
  try { return await Promise.race([request(), aborted]); }
  catch (error) {
    if (error instanceof VolcFileError) throw error;
    throw problem('无法连接火山文件转录服务，请检查网络后重试。', 'ASR_NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
