import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createVoiceprintRuntime } from './runtime.js';

const RATE = 16000;
const MAX_SEGMENTS = 4;
const MIN_SEGMENT_SECONDS = 3;
const MAX_SEGMENT_SECONDS = 30;
const MIN_TOTAL_SECONDS = 6;
const now = () => new Date().toISOString();
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const normalize = vector => {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw failure('声纹特征无效。');
  const norm = Math.hypot(...vector);
  if (!norm) throw failure('声纹特征为空。');
  return vector.map(value => value / norm);
};
const cosine = (a, b) => a.reduce((score, value, i) => score + value * b[i], 0);
const centroid = vectors => normalize(vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length));
const sameModel = (a, b) => a?.id === b?.id && a?.revision === b?.revision && a?.dimensions === b?.dimensions;

export function createVoiceprintService({ store, runtime = createVoiceprintRuntime({ dataDir: store.dataDir }), timeoutMs = 120000 } = {}) {
  const directory = path.join(store.dataDir, 'voiceprints');
  const jobsDir = path.join(directory, 'jobs');
  const profilesDir = path.join(directory, 'profiles');
  const samplesDir = path.join(directory, 'samples');
  for (const dir of [directory, jobsDir, profilesDir, samplesDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  const jobs = new Map();
  const profiles = new Map();
  const queue = [];
  let running = null, stopped = false;
  const save = (dir, value) => { const target = path.join(dir, `${value.id}.json`); writeFileSync(target, JSON.stringify(value), { mode: 0o600 }); chmodSync(target, 0o600); };
  const load = (dir, target) => {
    for (const name of readdirSync(dir)) if (/^[a-f0-9-]+\.json$/.test(name)) {
      try { const value = JSON.parse(readFileSync(path.join(dir, name), 'utf8')); if (value.id === name.slice(0, -5)) target.set(value.id, value); } catch { /* Corrupted optional metadata must not prevent recording startup. */ }
    }
  };
  load(jobsDir, jobs); load(profilesDir, profiles);
  for (const job of jobs.values()) if (['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; job.error = '服务已重启，请重新提交声纹任务。'; job.updatedAt = now(); save(jobsDir, job); }
  const updateJob = (job, patch) => { Object.assign(job, patch, { updatedAt: now() }); save(jobsDir, job); return clone(job); };
  function getParticipant(meetingId, participantId) {
    const participant = store.listParticipants(meetingId).find(item => item.id === participantId && !item.mergedInto);
    if (!participant) throw failure('说话人不存在或已合并，请重新选择。', 404);
    return participant;
  }
  function validateSources(input, { enrollment = false } = {}) {
    const meeting = store.getMeeting(input.meetingId);
    if (meeting.archived) throw failure('请先将会议移出归档，再使用声纹样本。');
    const participant = getParticipant(input.meetingId, input.participantId);
    if (enrollment && (participant.identitySource !== 'manual' || participant.needsConfirmation)) throw failure('请先人工确认这位说话人，再登记声纹。');
    const scope = input.scope || 'meeting';
    if (!['meeting', 'team'].includes(scope)) throw failure('声纹作用范围无效。');
    if (enrollment && scope === 'team') {
      if (!participant.memberId) throw failure('请先把说话人关联到团队成员，再登记团队声纹。');
      const member = store.getMember(participant.memberId);
      if (!member?.name?.trim() || member.archived || member.deleted) throw failure('团队成员不可用，请重新确认。');
    }
    const transcript = store.allTranscript(input.meetingId);
    let sourceIds = input.sourceIds;
    if (!sourceIds && !enrollment) sourceIds = transcript.filter(line => line.participantId === participant.id && line.timing !== 'chunk' && line.recordingId && line.endSample - line.startSample >= MIN_SEGMENT_SECONDS * RATE).sort((a, b) => (b.endSample - b.startSample) - (a.endSample - a.startSample)).slice(0, MAX_SEGMENTS).map(line => line.id);
    if (!Array.isArray(sourceIds) || sourceIds.length < 2 || sourceIds.length > MAX_SEGMENTS || new Set(sourceIds).size !== sourceIds.length) throw failure('请选择同一位说话人的 2–4 段清晰发言，每段至少 3 秒。');
    const lines = sourceIds.map(id => transcript.find(line => line.id === id));
    const segments = lines.map(line => {
      if (!line || line.participantId !== participant.id) throw failure('所选发言不属于同一位说话人，请重新选择。');
      const manuallyAssigned = ['host', 'agent'].includes(line.participantSource);
      if ((!line.speakerId || /^(unknown|unk)$/i.test(line.speakerId) || !participant.speakerIds?.length) && !manuallyAssigned) throw failure('请先明确这段未知发言属于谁，再登记或比较声纹。');
      if (line.timing === 'chunk') throw failure('这段转录只有整块时间，无法确定单人发言区间，请选择其他原文。');
      if (!line.recordingId || !Number.isSafeInteger(line.startSample) || !Number.isSafeInteger(line.endSample) || line.startSample < 0 || line.endSample <= line.startSample) throw failure('所选发言没有准确的本地录音位置。');
      const recording = store.getRecording(line.recordingId);
      if (recording.meetingId !== input.meetingId || recording.sampleRate !== RATE || line.endSample > recording.sampleCount) throw failure('录音位置无效，不能提取声纹。');
      const endSample = Math.min(line.endSample, line.startSample + MAX_SEGMENT_SECONDS * RATE);
      const duration = (endSample - line.startSample) / RATE;
      if (duration < MIN_SEGMENT_SECONDS) throw failure('每段声纹样本至少需要 3 秒，请选择长度合适的单人发言。');
      const overlap = transcript.some(other => other.id !== line.id && other.recordingId === line.recordingId && Number.isFinite(other.startSample) && Number.isFinite(other.endSample) && other.startSample < endSample && other.endSample > line.startSample && other.participantId !== participant.id);
      if (overlap) throw failure('所选区间包含其他说话人的发言，请改选没有重叠的片段。');
      // Only IDs returned by Store enter a PCM path; no caller-supplied filesystem paths.
      if (!/^[a-zA-Z0-9_-]+$/.test(recording.id)) throw failure('录音标识无效。');
      return { sourceId: line.id, revision: line.revision, recordingId: recording.id, startSample: line.startSample, endSample, sourceEndSample: line.endSample, duration };
    });
    if (segments.some((segment, index) => segments.slice(index + 1).some(other => segment.recordingId === other.recordingId && segment.startSample < other.endSample && segment.endSample > other.startSample))) throw failure('所选片段有重叠，请选择不同的完整发言。');
    if (segments.reduce((total, segment) => total + segment.duration, 0) < MIN_TOTAL_SECONDS) throw failure('清晰发言总时长至少需要 6 秒。');
    return { participant: clone(participant), sourceIds, segments, scope };
  }
  function profileAvailable(profile, meetingId) {
    if (profile.scope !== 'team' && profile.meetingId !== meetingId) return false;
    try {
      const participant = getParticipant(profile.meetingId, profile.participantId);
      if (participant.identitySource !== 'manual' || participant.needsConfirmation) return false;
      if (profile.scope === 'team') {
        const member = store.getMember(profile.memberId);
        if (!member || member.archived || member.deleted || participant.memberId !== profile.memberId) return false;
      }
      const lines = store.allTranscript(profile.meetingId);
      return profile.segments.every(segment => lines.some(line => line.id === segment.sourceId && line.participantId === profile.participantId && line.recordingId === segment.recordingId && line.startSample === segment.startSample && line.endSample === (segment.sourceEndSample ?? segment.endSample)));
    } catch { return false; }
  }
  function publicProfile(profile) {
    let name = profile.name;
    try { name = profile.scope === 'team' ? store.getMember(profile.memberId).name : getParticipant(profile.meetingId, profile.participantId).name; } catch { /* Retain the original manual label for metadata. */ }
    return { id: profile.id, scope: profile.scope, memberId: profile.memberId || null, meetingId: profile.meetingId, participantId: profile.participantId, name, model: profile.model, sourceIds: profile.sourceIds, segmentCount: profile.segments.length, durationSeconds: profile.segments.reduce((total, segment) => total + segment.duration, 0), createdAt: profile.createdAt };
  }
  function listProfiles({ meetingId } = {}) {
    if (!meetingId) return [...profiles.values()].filter(profile => profile.scope === 'team' && profileAvailable(profile, profile.meetingId)).map(publicProfile);
    store.getMeeting(meetingId);
    return [...profiles.values()].filter(profile => profileAvailable(profile, meetingId)).map(publicProfile);
  }
  async function extractClips(job, validated, signal) {
    const dir = path.join(samplesDir, job.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const paths = [];
    for (const [index, segment] of validated.segments.entries()) {
      signal.throwIfAborted();
      const handle = await open(path.join(store.dataDir, 'audio', `${segment.recordingId}.pcm`), 'r');
      const pcm = Buffer.alloc((segment.endSample - segment.startSample) * 2);
      try {
        let offset = 0;
        while (offset < pcm.length) {
          const { bytesRead } = await handle.read(pcm, offset, pcm.length - offset, segment.startSample * 2 + offset);
          if (!bytesRead) throw failure('本地录音不完整，无法提取所选发言。');
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      signal.throwIfAborted();
      let energy = 0, clipped = 0;
      for (let offset = 0; offset < pcm.length; offset += 2) { const sample = pcm.readInt16LE(offset) / 32768; energy += sample * sample; if (Math.abs(sample) >= 0.999) clipped++; }
      const sampleCount = pcm.length / 2;
      if (Math.sqrt(energy / sampleCount) < 0.001) throw failure('所选发言过于安静，请选择能清楚听到人声的片段。');
      if (clipped / sampleCount > 0.05) throw failure('所选发言失真较重，请选择其他清晰片段。');
      const target = path.join(dir, `${index + 1}.pcm`);
      await writeFile(target, pcm, { mode: 0o600 }); paths.push(target);
    }
    return paths;
  }
  async function run(job, signal) {
    const validated = validateSources(job.input, { enrollment: job.type === 'enroll' });
    const model = runtime.status().model;
    const paths = await extractClips(job, validated, signal);
    const raw = await runtime.extract(paths, { signal });
    signal.throwIfAborted();
    if (raw.length !== paths.length || raw.some(vector => vector.length !== model.dimensions)) throw failure('声纹模型返回的特征维度不符。');
    const vectors = raw.map(normalize);
    const current = validateSources(job.input, { enrollment: job.type === 'enroll' });
    if (JSON.stringify(current.segments) !== JSON.stringify(validated.segments) || current.participant.memberId !== validated.participant.memberId) throw failure('提取期间发言或说话人归属有修改，请重新选择样本。');
    // A high score is not a probability. These conservative guards are a trial
    // candidate filter, not a calibrated verification decision.
    const consistency = Math.min(...vectors.flatMap((vector, index) => vectors.slice(index + 1).map(other => cosine(vector, other))));
    if (consistency < 0.5) throw failure('这些片段的声音差异较大，请重新选择同一人的清晰发言。');
    const embedding = centroid(vectors);
    if (job.type === 'enroll') {
      const profile = { id: randomUUID(), scope: validated.scope, meetingId: job.meetingId, participantId: job.participantId, memberId: validated.scope === 'team' ? validated.participant.memberId : null, name: validated.participant.name, author: 'host', model, sourceIds: validated.sourceIds, segments: validated.segments, embedding, vectors, consistency, createdAt: now() };
      save(profilesDir, profile); profiles.set(profile.id, profile);
      return { status: 'enrolled', profile: publicProfile(profile), calibrated: false, message: '已保存人工确认的声纹样本；后续仅提供候选，不自动命名。' };
    }
    const eligible = [...profiles.values()].filter(profile => sameModel(profile.model, model) && profileAvailable(profile, job.meetingId) && !(profile.scope === 'meeting' && profile.participantId === job.participantId));
    const grouped = new Map();
    for (const profile of eligible) {
      const key = profile.scope === 'team' ? `team:${profile.memberId}` : `meeting:${profile.participantId}`;
      const score = cosine(embedding, profile.embedding);
      if (!Number.isFinite(score)) continue;
      if (!grouped.has(key) || grouped.get(key).score < score) grouped.set(key, { ...publicProfile(profile), score: Math.max(-1, Math.min(1, score)) });
    }
    const ranked = [...grouped.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const margin = best && ranked.length > 1 ? best.score - ranked[1].score : null;
    if (!best || best.score < 0.5 || margin !== null && margin < 0.08) return { status: 'unknown', candidates: [], calibrated: false, reason: !best ? 'no_profiles' : 'ambiguous_or_weak', model, message: '暂时没有足够清楚的声纹候选，请手动标记。' };
    return { status: 'candidate', candidates: ranked.filter(item => item.score >= 0.5).slice(0, 3), calibrated: false, model, scoreKind: 'cosine_similarity', message: '候选仍需人工确认。相似度不是身份概率，当前阈值尚未按团队会议校准。' };
  }
  async function pump() {
    if (running || stopped) return;
    const job = queue.shift();
    if (!job) return;
    if (job.status !== 'queued') return void pump();
    const controller = new AbortController();
    running = { job, controller };
    updateJob(job, { status: 'running' });
    const timer = setTimeout(() => controller.abort(new Error('声纹处理超时。')), timeoutMs);
    try { const result = await run(job, controller.signal); if (job.status !== 'cancelled') updateJob(job, { status: 'done', result, error: null }); }
    catch (error) { if (job.status !== 'cancelled') updateJob(job, { status: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? '声纹任务超时或已取消，仍可手动标记说话人。' : error.code === 'ENOENT' ? '所选发言的本地录音文件不存在，仍可手动标记。' : error.message }); }
    finally { clearTimeout(timer); running = null; if (!stopped) queueMicrotask(pump); }
  }
  function submit(type, input = {}) {
    if (!['enroll', 'match'].includes(type)) throw failure('声纹任务类型无效。');
    if (stopped) throw failure('声纹服务已停止。', 503);
    if (!runtime.status().available) throw failure('尚未安装本地声纹运行时，仍可手动标记说话人。', 409);
    const clean = { meetingId: input.meetingId, participantId: input.participantId, sourceIds: input.sourceIds, scope: input.scope || 'meeting' };
    const validated = validateSources(clean, { enrollment: type === 'enroll' });
    clean.sourceIds = validated.sourceIds;
    const existing = [...jobs.values()].find(job => ['queued', 'running'].includes(job.status) && job.type === type && JSON.stringify(job.input) === JSON.stringify(clean));
    if (existing) return clone(existing);
    const job = { id: randomUUID(), type, meetingId: clean.meetingId, participantId: clean.participantId, input: clean, status: 'queued', createdAt: now(), updatedAt: now(), result: null, error: null };
    jobs.set(job.id, job); save(jobsDir, job); queue.push(job); queueMicrotask(pump); return clone(job);
  }
  function getJob(id) { const job = jobs.get(id); if (!job) throw failure('声纹任务不存在。', 404); return clone(job); }
  function cancelJob(id) {
    const job = jobs.get(id); if (!job) throw failure('声纹任务不存在。', 404);
    if (['queued', 'running'].includes(job.status)) { updateJob(job, { status: 'cancelled', error: '声纹任务已取消。' }); if (running?.job.id === id) running.controller.abort(); }
    return clone(job);
  }
  async function stop() {
    stopped = true;
    for (const job of jobs.values()) if (['queued', 'running'].includes(job.status)) cancelJob(job.id);
  }
  function status() { return { ...runtime.status(), mode: 'suggestions_only', calibrated: false, pendingJobs: [...jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length, profileCount: profiles.size, sampleRequirements: { minSegments: 2, maxSegments: MAX_SEGMENTS, minSegmentSeconds: MIN_SEGMENT_SECONDS, maxSegmentSeconds: MAX_SEGMENT_SECONDS, minTotalSeconds: MIN_TOTAL_SECONDS }, candidatePolicy: { minimumCosine: 0.5, minimumMargin: 0.08, calibrated: false } }; }
  return { submit, getJob, cancelJob, status, listProfiles, stop };
}
