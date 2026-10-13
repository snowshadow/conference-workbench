import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { headersFor, diagnostics, serviceProblem, normalizeResult, VOLC_FILE_LIMITS } from './volcengine.js';
import { createTosStorage, TOS_PREFIX } from './tos.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/';
const PENDING = new Set(['20000001', '20000002']);
const fail = (message, code) => Object.assign(new Error(message), { publicMessage: message, code, status: 502 });
const abortError = () => Object.assign(fail('文件转录已暂停，录音和云端任务记录已保留。', 'ASR_ABORTED'), { name: 'AbortError' });

function readState(file) {
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state || !/^[a-f0-9-]{36}$/.test(state.requestId) || state.key !== `${TOS_PREFIX}${state.requestId}.wav` || !Number.isFinite(state.createdAt)) {
    throw fail('已保存的云端转录任务记录无效，原始录音已保留。', 'ASR_INVALID_STATE');
  }
  return state;
}
function writeState(file, state) {
  const temporary = `${file}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true });
  fs.renameSync(temporary, file);
}

async function request({ action, body = {}, config, requestId, signal, fetchImpl, requestTimeoutMs }) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  let response, reader;
  const cancelled = () => { try { (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); } catch {} };
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { cancelled(); rejectAbort(signal?.aborted ? abortError() : fail('火山文件转录请求超时，原任务已保留，可重试查询。', 'ASR_TIMEOUT')); };
  combined.addEventListener('abort', onAbort, { once: true });
  async function run() {
    if (combined.aborted) { onAbort(); return aborted; }
    const headers = { ...headersFor(config), 'X-Api-Request-Id': requestId };
    response = await fetchImpl(`${ENDPOINT}${action}`, { method: 'POST', headers, body: JSON.stringify(body), signal: combined, redirect: 'error' });
    if (combined.aborted) { cancelled(); return aborted; }
    const { code, logId } = diagnostics(response, config);
    if (!response.ok) { cancelled(); throw Object.assign(serviceProblem(response, code, logId), { httpStatus: response.status }); }
    if (!code) { cancelled(); throw fail('火山文件转录未返回有效的处理状态，请重试。', 'ASR_INVALID_RESPONSE'); }
    // Query status alone is sufficient unless a transcript is ready.
    if (action === 'submit' || code !== '20000000') { cancelled(); return { code, logId }; }
    const max = 16 * 1024 ** 2;
    if (Number(response.headers.get('Content-Length')) > max) { cancelled(); throw fail('转录结果过大，请缩短分段后重试。', 'ASR_RESPONSE_TOO_LARGE'); }
    if (!response.body) throw fail('火山文件转录返回了空结果，请重试。', 'ASR_INVALID_RESPONSE');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (combined.aborted) return aborted;
      if (done) break;
      size += value.byteLength;
      if (size > max) { cancelled(); throw fail('转录结果过大，请缩短分段后重试。', 'ASR_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('火山文件转录返回了无法读取的结果，请重试。', 'ASR_INVALID_RESPONSE'); }
    return { code, logId, result: normalizeResult(payload, logId) };
  }
  try { return await Promise.race([run(), aborted]); }
  catch (error) {
    if (error.publicMessage && /^(ASR_|HTTP_|\d{8})/.test(error.code || '')) throw error;
    throw fail('无法连接火山文件转录服务，云端任务记录已保留，可重试。', 'ASR_NETWORK_ERROR');
  } finally { combined.removeEventListener('abort', onAbort); }
}

/** Persist task identity before the first request, and results before cleanup.
 * Neither credentials nor signed audio URLs are written to the task record. */
export async function transcribeVolcStandardAudio({ audio, config, tos, stateFile, signal, fetchImpl = globalThis.fetch,
  requestTimeoutMs = 60000, pollIntervalMs = 5000, taskTimeoutMs = 3 * 60 * 60 * 1000, onProgress = () => {} }) {
  if (signal?.aborted) throw abortError();
  if (!Buffer.isBuffer(audio) || !audio.length || audio.length > VOLC_FILE_LIMITS.maxAudioBytes) throw fail('转录音频分段无效或超过 100 MB，原始录音已保留。', 'ASR_INVALID_AUDIO');
  headersFor(config); // Fail locally before uploading when speech credentials are missing.
  let state = readState(stateFile);
  const storage = () => createTosStorage({ config: { ...tos, region: state.region, bucket: state.bucket }, fetchImpl, requestTimeoutMs: Math.max(requestTimeoutMs, 300000) });
  const save = patch => { state = { ...state, ...patch }; writeState(stateFile, state); };
  async function cleanup() {
    if (state.cleaned) return;
    try { await storage().remove(state.key); save({ cleaned: true, cleanupPending: false }); }
    catch { save({ cleanupPending: true }); }
  }
  const output = async () => {
    await cleanup();
    return { ...state.result, ...(state.cleanupPending ? { cleanupWarning: '转录已保存，但 TOS 临时副本清理失败；请检查删除权限或桶生命周期规则。' } : {}) };
  };
  if (state?.result) return output();
  if (state?.failed) {
    await cleanup();
    if (!state.cleaned) throw fail('上次转录的 TOS 临时副本尚未清理，请检查删除权限后重试。', 'ASR_CLEANUP_PENDING');
    state = null;
  }
  const resumed = Boolean(state);
  if (!state) {
    createTosStorage({ config: tos, fetchImpl }); // Validate before persisting anything.
    const requestId = randomUUID();
    state = { requestId, key: `${TOS_PREFIX}${requestId}.wav`, region: tos.region, bucket: tos.bucket, resourceId: config.resourceId, createdAt: Date.now() };
    writeState(stateFile, state);
  }
  const invoke = async (action, body) => {
    try {
      return await request({ action, body, config: { ...config, resourceId: state.resourceId || config.resourceId }, requestId: state.requestId, signal, fetchImpl, requestTimeoutMs });
    } catch (error) {
      // An explicit rejection is terminal. A lost response is uncertain: keep
      // its task identity so a retry queries before submitting again.
      if (action === 'submit' && [400, 401, 403, 413].includes(error.httpStatus)) {
        save({ failed: true }); await cleanup();
      }
      throw error;
    }
  };
  let status = resumed ? await invoke('query') : { code: '45000092' };
  if (status.code === '45000092') {
    if (state.submitted) {
      // A task that once existed has expired. Only an explicit retry will
      // submit a new task, with a new ID; do not hide a second billable call.
      save({ failed: true }); await cleanup();
      throw fail('火山已找不到上次的转录任务。请重试以重新提交，可能再次产生转录费用。', 'ASR_TASK_EXPIRED');
    }
    onProgress('uploading');
    try { await storage().upload(state.key, audio, signal); }
    catch (error) {
      if (/^TOS_HTTP_4\d\d$/.test(error.code)) save({ failed: true, cleaned: true });
      throw error;
    }
    if (signal?.aborted) throw abortError();
    onProgress('transcribing');
    status = await invoke('submit', { user: { uid: 'meeting-workbench' }, audio: { url: storage().downloadUrl(state.key), format: 'wav', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, show_utterances: true, enable_speaker_info: true, ssd_version: '300' } });
    if (status.code === '20000000' || PENDING.has(status.code)) { save({ submitted: true }); status = { code: '20000002' }; }
    else if (status.code === '45000001') {
      const existing = await invoke('query');
      if (PENDING.has(existing.code) || ['20000000', '20000003'].includes(existing.code)) { save({ submitted: true }); status = existing; }
    }
  } else save({ submitted: true });
  const deadline = Date.now() + taskTimeoutMs;
  while (PENDING.has(status.code)) {
    onProgress('transcribing');
    if (Date.now() >= deadline) throw fail('云端转录等待超过 3 小时，原任务已保留，请稍后重试查询。', 'ASR_TIMEOUT');
    try { await delay(pollIntervalMs, undefined, { signal }); } catch { throw abortError(); }
    status = await invoke('query');
  }
  if (status.code === '20000000' || status.code === '20000003') {
    save({ result: status.result || { text: '', segments: [], noSpeech: true } });
    return output();
  }
  save({ failed: true }); await cleanup();
  throw serviceProblem({ status: 200 }, status.code, status.logId);
}
