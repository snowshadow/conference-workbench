import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import Busboy from 'busboy';
import { wav } from '../capture/service.js';
import { assertOutboundUrl, loadOutboundPolicy } from '../capture/outbound-url.js';
import { transcribeVolcAudio, VOLC_FILE_LIMITS } from './volcengine.js';

const RATE = 16000;
const LEGACY_CHUNK_SAMPLES = 60 * RATE;
const VOLC_CHUNK_SAMPLES = Math.min(VOLC_FILE_LIMITS.maxDurationSeconds * RATE, Math.floor((VOLC_FILE_LIMITS.maxAudioBytes - 44) / 2));
const MAX_LINE_CHARACTERS = 20000;
const FORMATS = 'wav,mp3,mov,matroska,webm,flac,ogg,aac,aiff,au,amr';
const EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.mp4', '.flac', '.ogg', '.oga', '.webm', '.mkv', '.mov', '.aac', '.aif', '.aiff', '.au', '.amr']);
const problem = (message, status = 400) => Object.assign(new Error(message), { status, publicMessage: message });
const interrupted = () => Object.assign(new Error('录音导入已暂停，服务恢复后继续。'), { name: 'AbortError' });
const date = () => new Date().toISOString();
const identifier = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

// All inputs are generated local paths. No shell is involved, and playlist/network
// demuxers cannot be selected by uploaded content pretending to be an audio file.
export function decodeAudio({ inputPath, outputPath, signal, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', decodeTimeoutMs = 120000, maxDecodedBytes = 2 * 1024 ** 3 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(interrupted());
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file', '-format_whitelist', FORMATS, '-i', inputPath,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(RATE),
      '-c:a', 'pcm_s16le', '-f', 's16le', '-fs', String(maxDecodedBytes), outputPath], { stdio: ['ignore', 'ignore', 'ignore'] });
    let timedOut = false;
    let abortKill;
    const abort = () => { child.kill('SIGTERM'); abortKill = setTimeout(() => child.kill('SIGKILL'), 2000); abortKill.unref?.(); };
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, decodeTimeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    const finish = error => { clearTimeout(timeout); clearTimeout(abortKill); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    child.once('error', error => finish(problem(error.code === 'ENOENT' ? '找不到 ffmpeg，请安装后重试导入。' : '无法启动音频解码，原始文件已保留。', 500)));
    child.once('close', code => {
      if (signal?.aborted) return finish(interrupted());
      if (timedOut) return finish(problem('音频解码超时，原始文件已保留，可重试。', 500));
      if (code !== 0) return finish(problem('无法读取此文件中的音轨，请检查文件是否完整及格式是否支持。原始文件已保留。'));
      const bytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      if (!bytes || bytes % 2) return finish(problem('文件中没有可读取的音频，原始文件已保留。'));
      if (bytes >= maxDecodedBytes) return finish(problem('解码后的录音超过 2 GiB，请拆分录音后导入。原始文件已保留。'));
      finish();
    });
  });
}

function readUpload(req, root, maxUploadBytes) {
  const uploadStarted = performance.now();
  const uploadId = randomUUID(), directory = path.join(root, uploadId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const partialPath = path.join(directory, 'upload.partial');
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: maxUploadBytes, files: 1, fields: 2, fieldSize: 24000, parts: 4 } }); }
    catch { reject(problem('请以文件上传方式提交录音。')); return; }
    const fields = {}, writes = [];
    let filename = '', received = false, failure = null, settled = false;
    const mark = error => { failure ||= error; };
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const onAbort = () => { mark(problem('录音上传已中断，已接收的部分保留在本机。')); parser.destroy(); fail(failure); };
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    parser.on('field', (name, value, info) => {
      if (!['title', 'goal'].includes(name) || Object.hasOwn(fields, name) || info.valueTruncated) mark(problem('录音上传字段无效或过长。'));
      else fields[name] = value;
    });
    parser.on('file', (name, file, info) => {
      if (name !== 'file' || received) { mark(problem('每次只能导入一个录音文件。')); file.resume(); return; }
      received = true;
      filename = path.basename(String(info.filename || '').replaceAll('\\', '/')).slice(0, 240);
      const output = fs.createWriteStream(partialPath, { flags: 'wx', mode: 0o600 });
      file.once('limit', () => mark(problem('录音文件超过 512 MiB，请拆分后导入。', 413)));
      const writing = new Promise(done => {
        output.once('finish', done);
        output.once('close', done);
        output.once('error', () => { mark(problem('录音文件保存失败，请检查本机磁盘空间。', 500)); file.resume(); done(); });
        file.once('error', () => { mark(problem('录音上传不完整，已接收的部分保留在本机。')); output.destroy(); done(); });
      });
      writes.push(writing);
      // Parse failure may otherwise leave an open output stream after a dropped client.
      parser.once('error', () => { output.destroy(); });
      file.pipe(output);
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => mark(problem('录音上传字段过多，每次只能导入一个文件。')));
    parser.once('error', () => fail(failure || problem('录音上传不完整，已接收的部分保留在本机。')));
    parser.once('close', async () => {
      try {
      await Promise.all(writes);
      req.off('aborted', onAbort); req.off('error', onAbort);
      if (settled) return;
      if (failure) return fail(failure);
      if (!received || !fs.existsSync(partialPath) || !fs.statSync(partialPath).size) return fail(problem('请选择一个非空录音文件。'));
      const fd = fs.openSync(partialPath, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // The extension only selects a display/validation hint. The user never controls a path.
      const extension = path.extname(filename).toLowerCase();
      const storedFilename = `original${EXTENSIONS.has(extension) ? extension : '.upload'}`;
      fs.renameSync(partialPath, path.join(directory, storedFilename));
      settled = true;
      resolve({ uploadId, originalFilename: filename || '导入录音', storedFilename, supported: EXTENSIONS.has(extension), title: fields.title?.trim().slice(0, 200), goal: fields.goal?.trim().slice(0, 6000) || '', uploadMs: Math.round(performance.now() - uploadStarted) });
      } catch { fail(problem('录音文件保存失败，请检查本机磁盘空间。已接收的内容保留在本机。', 500)); }
    });
    req.pipe(parser);
  });
}

function providerLines(response, chunkIndex, startSample, endSample, recordingId) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw problem('文件转录服务返回了无法识别的结果，请检查模型配置后重试。', 502);
  const fullText = typeof response.text === 'string' ? response.text.trim() : '';
  const segments = Array.isArray(response.segments) ? response.segments : [];
  if (typeof response.text !== 'string' && !Array.isArray(response.segments)) throw problem('文件转录服务未返回转录文本，请检查模型配置后重试。', 502);
  const seconds = (endSample - startSample) / RATE;
  const segmentText = segments.map(item => typeof item?.text === 'string' ? item.text.trim() : '').filter(Boolean).join(' ');
  const valid = segments.length > 0 && (!fullText || fullText.replace(/\s/g, '') === segmentText.replace(/\s/g, '')) && segments.every(item => item && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.start < seconds && item.end > item.start && item.end <= seconds + 0.1 && Math.round(item.start * RATE) < Math.min(endSample - startSample, Math.round(item.end * RATE)));
  const text = fullText || segmentText;
  const inputs = valid ? segments.map(item => ({ text: item.text.trim(), startSample: startSample + Math.round(item.start * RATE), endSample: Math.min(endSample, startSample + Math.round(item.end * RATE)), timing: 'segment', speaker: item.speaker_id ?? item.speaker })) : text ? [{ text, startSample, endSample, timing: 'chunk' }] : [];
  // Long recordings can contain many short utterances. Only the store's per-line
  // limit applies; never silently truncate a sentence or invent timings to split it.
  if (inputs.some(item => item.text.length > MAX_LINE_CHARACTERS)) throw problem(valid
    ? '文件转录服务返回了超过 20,000 字的单条发言，无法完整保存。请检查服务的分句设置后重试；录音已保留。'
    : '文件转录文本超过 20,000 字，但没有可用的逐句时间，无法完整保存。请检查服务的分句设置后重试；录音已保留。', 502);
  return inputs.map((item, index) => ({
    id: createHash('sha256').update(`${recordingId}:${chunkIndex}:${index}`).digest('hex'), recordingId,
    text: item.text, startSample: item.startSample, endSample: item.endSample,
    startMs: item.startSample / 16, endMs: item.endSample / 16, timing: item.timing, origin: 'asr',
    // Speaker labels from independent file requests do not establish identity across chunks.
    speakerId: ['string', 'number'].includes(typeof item.speaker) && String(item.speaker).trim() ? `import-${chunkIndex}-speaker-${String(item.speaker).trim().slice(0, 60)}` : 'unknown',
  }));
}

/** File import uses its own persistent queue; a completed upload is never live capture. */
export function createImportService({ store, ai, onTranscript = () => {}, fetchImpl = globalThis.fetch, decode = decodeAudio, chunkSeconds, maxUploadBytes = 512 * 1024 ** 2, requestTimeoutMs = 300000, ...decodeOptions }) {
  const importsDir = path.join(store.dataDir, 'imports'), audioDir = path.join(store.dataDir, 'audio');
  fs.mkdirSync(importsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  let started = false, worker = null, currentController = null;
  const explicitChunkSamples = chunkSeconds === undefined ? null : Math.max(1, Math.round(chunkSeconds * RATE));
  if (explicitChunkSamples !== null && !Number.isSafeInteger(explicitChunkSamples)) throw problem('录音分段长度无效。');
  const paths = job => {
    if (!identifier(job.input.uploadId) || !identifier(job.input.recordingId) || !/^original\.(wav|mp3|m4a|mp4|flac|ogg|oga|webm|mkv|mov|aac|aif|aiff|au|amr|upload)$/.test(job.input.storedFilename)) throw problem('导入任务的文件记录无效。');
    const directory = path.join(importsDir, job.input.uploadId);
    return { directory, original: path.join(directory, job.input.storedFilename), pcm: path.join(audioDir, `${job.input.recordingId}.pcm`) };
  };
  function createPlan(config = {}, legacy = false) {
    const provider = config.provider === 'volcengine' ? 'volcengine' : 'openai';
    const asrPlan = provider === 'volcengine'
      ? { provider, resourceId: config.resourceId || 'volc.bigasr.auc_turbo' }
      : { provider, baseUrl: config.baseUrl || '', model: config.model || '', language: config.language || '' };
    // Do not persist credentials hidden inside an invalid endpoint URL. The
    // missing address is reported as a configuration error before any request.
    if (provider === 'openai') {
      try { const url = new URL(asrPlan.baseUrl); if (url.username || url.password || url.search || url.hash) asrPlan.baseUrl = ''; }
      catch { asrPlan.baseUrl = ''; }
    }
    const requested = legacy ? LEGACY_CHUNK_SAMPLES : explicitChunkSamples ?? (provider === 'volcengine' ? VOLC_CHUNK_SAMPLES : LEGACY_CHUNK_SAMPLES);
    return { chunkSamples: provider === 'volcengine' ? Math.min(requested, VOLC_CHUNK_SAMPLES) : requested, asrPlan };
  }
  function ensurePlan(job, files) {
    const hasSize = Object.hasOwn(job.input, 'chunkSamples'), hasPlan = Object.hasOwn(job.input, 'asrPlan');
    if (hasSize && (!Number.isSafeInteger(job.input.chunkSamples) || job.input.chunkSamples < 1)) throw problem('录音任务的分段计划无效，原始录音和已保存转录已保留。');
    if (hasPlan && !['volcengine', 'openai'].includes(job.input.asrPlan?.provider)) throw problem('录音任务的转录服务记录无效，原始录音和已保存转录已保留。');
    if (hasSize && hasPlan) return job;
    const chunksDir = path.join(files.directory, 'chunks');
    const hasCheckpoints = fs.existsSync(chunksDir) && fs.readdirSync(chunksDir).some(name => /^\d+\.json$/.test(name));
    // Older jobs never saved a provider or a plan. Once decoding/checkpointing
    // started, their IDs and offsets were based on 60 seconds; retain that grid.
    // Their unknown provider can only be recovered from the current settings.
    const legacy = Boolean(job.input.decoded || job.input.completedChunks > 0 || hasCheckpoints || fs.existsSync(files.pcm));
    const plan = createPlan(hasPlan ? job.input.asrPlan : store.getSettings().fileAsr, legacy);
    return store.updateJob(job.id, { input: { ...job.input, chunkSamples: hasSize ? job.input.chunkSamples : plan.chunkSamples, asrPlan: hasPlan ? job.input.asrPlan : plan.asrPlan } });
  }
  function gaps(job, error = '') {
    const recording = store.getRecording(job.input.recordingId);
    const completed = Math.min(recording.sampleCount, (job.input.completedChunks || 0) * (job.input.chunkSamples || LEGACY_CHUNK_SAMPLES));
    const retained = (recording.gaps || []).filter(gap => gap.importKind !== 'pending');
    if (completed < recording.sampleCount) retained.push({ startSample: completed, endSample: recording.sampleCount, reason: error || '录音已保存，此区间等待文件转录。', importKind: 'pending' });
    store.updateRecording(recording.id, { gaps: retained });
  }
  async function transcribe(pcm, signal, plan) {
    const settings = store.getSettings(), config = { ...plan, apiKey: settings.fileAsr?.apiKey };
    if (config.provider === 'volcengine') {
      return transcribeVolcAudio({ audio: wav(pcm), config: { ...settings.asr, resourceId: config.resourceId }, signal, fetchImpl, requestTimeoutMs });
    }
    if (!config.baseUrl || !config.model) throw problem('请先在连接设置中配置录音文件转录服务，再重试导入。');
    let base;
    try {
      const policy = loadOutboundPolicy();
      // A local file-ASR endpoint is an explicit user setting, including when other
      // providers are restricted to public networks. Keep the named allowlist intact.
      if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname)) policy.blockPrivate = false;
      base = assertOutboundUrl(config.baseUrl, policy, { protocols: ['http:', 'https:'], label: '文件转录地址' });
    }
    catch { throw problem('文件转录服务地址不可用，请检查连接设置。'); }
    if (base.username || base.password || base.search || base.hash) throw problem('文件转录服务地址不能包含账号、密码或查询参数。');
    const endpoint = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/audio/transcriptions';
    const form = new FormData();
    form.append('model', config.model); form.append('response_format', 'json'); form.append('word_timestamps', 'true');
    if (config.language) form.append('language', config.language);
    form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'meeting-chunk.wav');
    const timeout = AbortSignal.timeout(requestTimeoutMs), requestSignal = AbortSignal.any([signal, timeout]);
    let response;
    try { response = await fetchImpl(endpoint, { method: 'POST', headers: { Accept: 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: form, signal: requestSignal, redirect: 'error' }); }
    catch { if (signal.aborted) throw interrupted(); throw problem(timeout.aborted ? '文件转录超时，已保存的音频和转录会保留，请重试。' : '无法连接文件转录服务，请检查服务是否运行及地址配置。', 502); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Do not expose provider response bodies. */ }
      const messages = { 401: '文件转录服务认证失败，请检查 API Key。', 403: '文件转录服务拒绝访问，请检查 API Key 和服务权限。', 404: '文件转录接口或模型不存在，请检查服务地址和模型名称。', 413: '文件转录服务拒绝了音频分段，请检查服务上传限制。', 429: '文件转录服务暂时繁忙，请稍后重试。' };
      throw problem(messages[response.status] || `文件转录服务处理失败（HTTP ${response.status}），录音已保留，可重试。`, 502);
    }
    try {
      const chunks = []; let size = 0;
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 ** 2) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch { if (signal.aborted) throw interrupted(); throw problem('文件转录服务没有返回有效 JSON，录音已保留，请检查配置后重试。', 502); }
  }
  async function run(initial) {
    let job = store.getJob(initial.id);
    // Cumulative work time survives retries. Queue waiting is not audio processing.
    const timings = { uploadMs: job.input.uploadMs || 0, ...job.timings };
    const measure = async (phase, action) => {
      const start = performance.now();
      try { return await action(); }
      finally {
        timings[phase] = (timings[phase] || 0) + Math.round(performance.now() - start);
        store.updateJob(job.id, { timings });
      }
    };
    const controller = new AbortController(); currentController = controller;
    try {
      job = store.updateJob(job.id, { status: 'running', error: null, progress: { ...job.progress, phase: job.input.decoded ? 'transcribing' : 'decoding' } });
      const files = paths(job);
      if (!fs.existsSync(files.original)) throw problem('找不到已上传的原始录音文件。');
      if (!job.input.supported) throw problem('暂不支持此文件格式。请使用 WAV、MP3、M4A、MP4、FLAC、OGG 或 WebM；原始文件已保留。');
      job = ensurePlan(job, files);
      const chunkSamples = job.input.chunkSamples;
      if (!job.input.decoded) {
        const staging = path.join(files.directory, `decoded-${randomUUID()}.pcm.partial`);
        await measure('decodeMs', () => decode({ inputPath: files.original, outputPath: staging, signal: controller.signal, ...decodeOptions }));
        if (controller.signal.aborted) throw interrupted();
        const bytes = fs.statSync(staging).size;
        if (!bytes || bytes % 2) throw problem('解码后的音频无效，原始文件已保留。');
        const fd = fs.openSync(staging, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(staging, files.pcm);
        const sampleCount = bytes / 2, totalChunks = Math.ceil(sampleCount / chunkSamples);
        store.updateRecording(job.input.recordingId, { sampleCount, state: 'stopped', endedAt: date() });
        job = store.updateJob(job.id, { input: { ...job.input, decoded: true }, progress: { phase: 'transcribing', completedChunks: 0, totalChunks, processedSeconds: 0, totalSeconds: sampleCount / RATE } });
      }
      const recording = store.getRecording(job.input.recordingId);
      if (!fs.existsSync(files.pcm) || fs.statSync(files.pcm).size !== recording.sampleCount * 2) throw problem('已保存的录音长度与记录不一致，请检查本机音频文件。');
      gaps(job);
      const chunksDir = path.join(files.directory, 'chunks'); fs.mkdirSync(chunksDir, { recursive: true, mode: 0o700 });
      const knownIds = new Set(store.allTranscript(job.meetingId).map(line => line.id));
      const totalChunks = Math.ceil(recording.sampleCount / chunkSamples);
      const fd = fs.openSync(files.pcm, 'r');
      try {
        for (let index = job.input.completedChunks || 0; index < totalChunks; index++) {
          if (controller.signal.aborted || !started) throw interrupted();
          const startSample = index * chunkSamples, endSample = Math.min(recording.sampleCount, startSample + chunkSamples);
          const checkpointPath = path.join(chunksDir, `${String(index).padStart(6, '0')}.json`);
          let lines;
          if (fs.existsSync(checkpointPath)) lines = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).lines;
          else {
            const pcm = Buffer.alloc((endSample - startSample) * 2);
            let count = 0; while (count < pcm.length) { const read = fs.readSync(fd, pcm, count, pcm.length - count, startSample * 2 + count); if (!read) throw problem('读取已保存的录音失败。'); count += read; }
            lines = providerLines(await measure('asrMs', () => transcribe(pcm, controller.signal, job.input.asrPlan)), index, startSample, endSample, recording.id);
            if (controller.signal.aborted) throw interrupted();
            const temporary = `${checkpointPath}.${randomUUID()}.partial`;
            fs.writeFileSync(temporary, JSON.stringify({ lines }), { mode: 0o600, flag: 'wx', flush: true });
            fs.renameSync(temporary, checkpointPath);
          }
          if (!Array.isArray(lines) || lines.some(line => typeof line?.text !== 'string' || line.text.length > MAX_LINE_CHARACTERS)) throw problem('已保存的转录分段无法完整读取，原始录音和已保存转录已保留。', 500);
          let changed = false;
          const publish = () => { if (changed) { changed = false; Promise.resolve().then(() => onTranscript(job.meetingId)).catch(() => {}); } };
          await measure('saveMs', async () => {
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
              const line = lines[lineIndex];
              if (!knownIds.has(line.id)) { store.appendTranscript(job.meetingId, line); knownIds.add(line.id); changed = true; }
              if ((lineIndex + 1) % 50 === 0) {
                publish();
                // A whole recording may yield thousands of utterances. Keep HTTP,
                // live capture and cancellation responsive while committing them.
                await yieldToEvents();
                if (controller.signal.aborted || !started) throw interrupted();
              }
            }
            publish();
          });
          if (!lines.length) {
            const rec = store.getRecording(recording.id), oldGaps = (rec.gaps || []).filter(gap => gap.importKind !== 'pending');
            if (!oldGaps.some(gap => gap.importKind === 'no_speech' && gap.startSample === startSample)) oldGaps.push({ startSample, endSample, reason: '此区间未识别出文字，请回听核对。', importKind: 'no_speech' });
            store.updateRecording(recording.id, { gaps: oldGaps });
          }
          job = store.updateJob(job.id, { input: { ...job.input, completedChunks: index + 1 }, progress: { phase: 'transcribing', completedChunks: index + 1, totalChunks, processedSeconds: endSample / RATE, totalSeconds: recording.sampleCount / RATE } });
          gaps(job);
        }
      } finally { fs.closeSync(fd); }
      if (controller.signal.aborted || !started) throw interrupted();
      const transcriptCount = store.allTranscript(job.meetingId).filter(line => line.recordingId === recording.id).length;
      let analysisJobId = job.input.analysisJobId || null;
      let analysisState = transcriptCount ? 'not_configured' : 'no_transcript';
      let message = transcriptCount ? '录音和转录已保存。配置大模型后可生成澄清建议与纪要。' : '录音已保存，但未识别出文字；可回听核对，检查文件转录模型。';
      if (transcriptCount && store.publicSettings().llm?.configured) {
        try {
          analysisJobId ||= ai.submit(job.meetingId, 'minutes').id;
          job = store.updateJob(job.id, { input: { ...job.input, analysisJobId } });
          analysisState = 'queued'; message = '录音和转录已保存，正在整理主题、澄清建议与纪要。';
        } catch { analysisState = 'failed'; message = '录音和转录已保存，自动整理未启动，可稍后手动生成纪要。'; }
      }
      store.updateJob(job.id, { status: 'done', error: null, progress: { ...job.progress, phase: 'done' }, result: { recordingId: recording.id, transcriptCount, durationMs: recording.sampleCount / 16, analysisJobId, analysisState, message } });
    } catch (error) {
      job = store.getJob(initial.id);
      if (error.name === 'AbortError' || !started) {
        store.updateJob(job.id, { status: 'queued', error: null });
      } else {
        const message = error.publicMessage || '录音导入失败，已接收的文件和已完成转录保留在本机，可重试。';
        store.updateJob(job.id, { status: 'error', error: message, progress: { ...job.progress, phase: 'error' } });
        if (job.input.decoded) gaps(job, '文件转录未完成，录音已保存，可重试或回听核对。');
      }
    } finally { currentController = null; }
  }
  function schedule() {
    if (!started || worker) return;
    worker = Promise.resolve().then(async () => {
      while (started) {
        const job = store.listJobs().filter(item => item.type === 'import' && ['queued', 'running'].includes(item.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!job) break;
        await run(job);
      }
    }).finally(() => {
      worker = null;
      if (started && store.listJobs().some(item => item.type === 'import' && ['queued', 'running'].includes(item.status))) schedule();
    });
  }
  return {
    async receive(req) {
      if (!started) throw problem('录音导入服务正在关闭，请稍后重试。', 503);
      const upload = await readUpload(req, importsDir, maxUploadBytes);
      if (!started) throw problem('服务已停止，上传文件保留在本机，请重新导入。', 503);
      const meeting = store.createMeeting({ title: upload.title || path.parse(upload.originalFilename).name || '导入录音', goal: upload.goal });
      const recording = store.createRecording(meeting.id, { state: 'stopped', timelineStartMs: 0, source: 'recording_import', originalFilename: upload.originalFilename, endedAt: date() });
      const job = store.createJob(meeting.id, 'import', { ...upload, recordingId: recording.id, completedChunks: 0, decoded: false, ...createPlan(store.getSettings().fileAsr) });
      store.updateJob(job.id, { progress: { phase: 'decoding', completedChunks: 0, totalChunks: 0, processedSeconds: 0, totalSeconds: 0 } });
      const updated = store.updateMeeting(meeting.id, { status: 'ended', source: 'recording_import', importJobId: job.id, endedAt: date(), autoOrganize: false });
      schedule();
      return { meeting: updated, job: store.getJob(job.id) };
    },
    retry(meetingId) {
      const meeting = store.getMeeting(meetingId);
      const job = meeting.importJobId ? store.getJob(meeting.importJobId) : store.listJobs(meetingId).find(item => item.type === 'import');
      if (!job || job.type !== 'import') throw problem('这场会议没有可重试的录音导入任务。', 404);
      if (job.status === 'error') {
        const config = store.getSettings().fileAsr || {};
        if (job.input.asrPlan && job.input.asrPlan.provider !== (config.provider === 'volcengine' ? 'volcengine' : 'openai')) {
          const provider = job.input.asrPlan.provider === 'volcengine' ? '火山引擎' : 'OpenAI 兼容服务';
          throw problem(`这项导入使用${provider}，请在连接设置中切回该服务后重试。已保存的录音和转录会保留。`, 409);
        }
        // An explicit retry may follow a corrected endpoint/model/resource.
        // Refresh those settings, but never change saved chunk boundaries.
        const input = job.input.asrPlan ? { ...job.input, asrPlan: createPlan(config).asrPlan } : job.input;
        store.updateJob(job.id, { input, status: 'queued', error: null, progress: { ...job.progress, phase: job.input.decoded ? 'transcribing' : 'decoding' } });
      }
      schedule(); return store.getJob(job.id);
    },
    start() { if (started) return; started = true; schedule(); },
    async stop() { started = false; currentController?.abort(); await worker; },
  };
}
