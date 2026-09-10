import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createVoiceprintRuntime } from './runtime.js';
import { VOICEPRINT_POLICY, isVoiceprintTextEligible, assessAutoMatch, voiceprintIdentityKey } from '../../shared/voiceprint-policy.js';

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
  const cacheDir = path.join(directory, 'embedding-cache');
  for (const dir of [directory, jobsDir, profilesDir, samplesDir, cacheDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
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
  // Store.allTranscript contains finalized utterances. Also guard explicit partial flags
  // so an adapter cannot accidentally pass in-progress hypotheses to this service.
  function eligibleLine(line, participant, transcript, meetingId, automatic = false) {
    if (line.participantId !== participant.id || line.final === false || line.definite === false || line.isFinal === false || line.partial === true) throw failure('请等待这段发言转录完成。');
    if (!isVoiceprintTextEligible(line.text) || /^[\s[（(]*(听不清|无法识别|无法辨认|静音|音乐|噪音|笑声|inaudible|silence)[\s\]）)]*$/i.test(line.text)) throw failure('发言少于 4 个字或没有清晰内容，请选择其他片段。');
    const manuallyAssigned = ['host', 'agent'].includes(line.participantSource);
    if ((!line.speakerId || /^(unknown|unk|speaker-unknown)$/i.test(line.speakerId) || !participant.speakerIds?.length) && (automatic || !manuallyAssigned)) throw failure('请先明确这段未知发言属于谁，再登记或比较声纹。');
    if (line.timing === 'chunk') throw failure('这段转录只有整块时间，无法确定单人发言区间，请选择其他原文。');
    if (!line.recordingId || !Number.isSafeInteger(line.startSample) || !Number.isSafeInteger(line.endSample) || line.startSample < 0 || line.endSample <= line.startSample) throw failure('所选发言没有准确的本地录音位置。');
    const recording = store.getRecording(line.recordingId);
    if (recording.meetingId !== meetingId || recording.sampleRate !== RATE || line.endSample > recording.sampleCount) throw failure('录音位置无效，不能提取声纹。');
    const endSample = Math.min(line.endSample, line.startSample + MAX_SEGMENT_SECONDS * RATE);
    const duration = (endSample - line.startSample) / RATE;
    if (duration < MIN_SEGMENT_SECONDS) throw failure('每段声纹样本至少需要 3 秒，请选择长度合适的单人发言。');
    const overlap = transcript.some(other => other.id !== line.id && other.recordingId === line.recordingId && Number.isFinite(other.startSample) && Number.isFinite(other.endSample) && other.startSample < endSample && other.endSample > line.startSample && other.participantId !== participant.id);
    if (overlap) throw failure('所选区间包含其他说话人的发言，请改选没有重叠的片段。');
    if (!/^[a-zA-Z0-9_-]+$/.test(recording.id)) throw failure('录音标识无效。');
    if (automatic && !existsSync(path.join(store.dataDir, 'audio', `${recording.id}.pcm`))) throw failure('这段录音尚未保存。');
    return { sourceId: line.id, revision: line.revision, recordingId: recording.id, startSample: line.startSample, endSample, sourceEndSample: line.endSample, duration };
  }
  function selectSamples(meetingId, participantId, { automatic = true, excludeSourceIds = [] } = {}) {
    const meeting = store.getMeeting(meetingId);
    if (meeting.archived) return [];
    const participant = getParticipant(meetingId, participantId);
    const transcript = store.allTranscript(meetingId), excluded = new Set(excludeSourceIds), selected = [];
    const candidates = transcript.filter(line => !excluded.has(line.id)).flatMap(line => {
      try { return [eligibleLine(line, participant, transcript, meetingId, automatic)]; } catch { return []; }
    }).sort((a, b) => b.duration - a.duration || a.startSample - b.startSample);
    for (const segment of candidates) {
      if (selected.some(other => other.recordingId === segment.recordingId && other.startSample < segment.endSample && other.endSample > segment.startSample)) continue;
      selected.push(segment);
      if (selected.length === MAX_SEGMENTS) break;
    }
    return selected.length < 2 ? [] : selected.map(segment => segment.sourceId);
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
    if (!sourceIds && !enrollment) sourceIds = selectSamples(input.meetingId, input.participantId, { automatic: input.automatic === true });
    if (!Array.isArray(sourceIds) || sourceIds.length < 2 || sourceIds.length > MAX_SEGMENTS || new Set(sourceIds).size !== sourceIds.length) throw failure('请选择同一位说话人的 2–4 段清晰发言，每段至少 3 秒。');
    const lines = sourceIds.map(id => transcript.find(line => line.id === id));
    const segments = lines.map(line => {
      if (!line || line.participantId !== participant.id) throw failure('所选发言不属于同一位说话人，请重新选择。');
      return eligibleLine(line, participant, transcript, input.meetingId, input.automatic === true);
    });
    if (segments.some((segment, index) => segments.slice(index + 1).some(other => segment.recordingId === other.recordingId && segment.startSample < other.endSample && segment.endSample > other.startSample))) throw failure('所选片段有重叠，请选择不同的完整发言。');
    if (segments.reduce((total, segment) => total + segment.duration, 0) < MIN_TOTAL_SECONDS) throw failure('清晰发言总时长至少需要 6 秒。');
    return { participant: clone(participant), sourceIds, segments, scope };
  }
  const lookup = (context, bucket, key, read) => {
    const cache = context[bucket] ||= new Map();
    if (!cache.has(key)) cache.set(key, read());
    return cache.get(key);
  };
  function profileAvailability(profile, meetingId, context = {}) {
    if (profile.enabled === false) return { available: false, unavailableReason: 'disabled', unavailableMessage: '已停用，可以重新启用。' };
    if (profile.scope !== 'team' && profile.meetingId !== meetingId) return { available: false, unavailableReason: 'different_meeting', unavailableMessage: '访客样本仅用于登记时的会议。' };
    if (!sameModel(profile.model, context.model ||= runtime.status().model)) return { available: false, unavailableReason: 'model_changed', unavailableMessage: '声纹模型已更换，需要重新保存样本。' };
    if (!Array.isArray(profile.embedding) || profile.embedding.length !== profile.model.dimensions || !profile.embedding.every(Number.isFinite)) return { available: false, unavailableReason: 'invalid_profile', unavailableMessage: '声音特征不可用，请重新保存样本。' };
    try {
      const participant = lookup(context, 'participants', profile.meetingId, () => store.listParticipants(profile.meetingId)).find(item => item.id === profile.participantId && !item.mergedInto);
      if (!participant) throw failure('说话人不可用');
      if (participant.identitySource !== 'manual' || participant.needsConfirmation) return { available: false, unavailableReason: 'identity_unconfirmed', unavailableMessage: '请先确认样本属于谁。' };
      if (profile.scope === 'team') {
        const member = lookup(context, 'members', profile.memberId, () => store.getMember(profile.memberId));
        if (!member || member.archived || member.deleted) return { available: false, unavailableReason: 'member_unavailable', unavailableMessage: '这位团队成员已不可用。' };
        if (participant.memberId !== profile.memberId) return { available: false, unavailableReason: 'identity_changed', unavailableMessage: '样本的说话人归属已更正，请重新保存。' };
      }
      const lines = lookup(context, 'transcripts', profile.meetingId, () => store.allTranscript(profile.meetingId));
      if (!profile.segments.every(segment => lines.some(line => line.id === segment.sourceId && line.participantId === profile.participantId && line.recordingId === segment.recordingId && line.startSample === segment.startSample && line.endSample === (segment.sourceEndSample ?? segment.endSample)))) return { available: false, unavailableReason: 'source_changed', unavailableMessage: '样本发言或录音区间已更正，请重新保存。' };
      if (!profile.segments.every(segment => /^[a-zA-Z0-9_-]+$/.test(segment.recordingId) && existsSync(path.join(store.dataDir, 'audio', `${segment.recordingId}.pcm`)))) return { available: false, unavailableReason: 'audio_unavailable', unavailableMessage: '原始录音不可用。' };
      return { available: true, unavailableReason: null, unavailableMessage: null };
    } catch { return { available: false, unavailableReason: 'source_unavailable', unavailableMessage: '原会议或说话人已不可用。' }; }
  }
  const profileAvailable = (profile, meetingId, context) => profileAvailability(profile, meetingId, context).available;
  function publicProfile(profile, meetingId = profile.meetingId, context = {}) {
    let name = profile.name;
    try { name = profile.scope === 'team' ? lookup(context, 'members', profile.memberId, () => store.getMember(profile.memberId)).name : lookup(context, 'participants', profile.meetingId, () => store.listParticipants(profile.meetingId)).find(item => item.id === profile.participantId && !item.mergedInto).name; } catch { /* Retain the original manual label for metadata. */ }
    const segments = profile.segments.map(segment => ({ sourceId: segment.sourceId, recordingId: segment.recordingId, startSample: segment.startSample, endSample: segment.endSample, duration: segment.duration }));
    return { id: profile.id, scope: profile.scope, memberId: profile.memberId || null, meetingId: profile.meetingId, participantId: profile.participantId, name, model: profile.model, sourceIds: profile.sourceIds, segments, segmentCount: profile.segments.length, durationSeconds: profile.segments.reduce((total, segment) => total + segment.duration, 0), createdAt: profile.createdAt, updatedAt: profile.updatedAt || profile.createdAt, enabled: profile.enabled !== false, ...profileAvailability(profile, meetingId, context) };
  }
  function listProfiles({ meetingId, includeUnavailable = false } = {}) {
    if (meetingId) store.getMeeting(meetingId);
    const context = {};
    return [...profiles.values()].filter(profile => profile.scope === 'team' || meetingId && profile.meetingId === meetingId).map(profile => publicProfile(profile, meetingId || profile.meetingId, context)).filter(profile => includeUnavailable || profile.available);
  }
  function setProfileEnabled(id, enabled) {
    const profile = profiles.get(id);
    if (!profile) throw failure('声音样本不存在。', 404);
    if (typeof enabled !== 'boolean') throw failure('请明确是否启用声音样本。');
    profile.enabled = enabled; profile.updatedAt = now(); save(profilesDir, profile);
    return publicProfile(profile);
  }
  async function extractClips(job, validated, signal) {
    // One shared four-slot workspace: tasks are serial and PCM excerpts need no permanent copy.
    const dir = path.join(samplesDir, 'work');
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
    // Keep at most eight reusable vectors per participant, replacing the same JSON file.
    // Source revision and exact audio bounds prevent edited samples from reusing stale results.
    const cacheFile = path.join(cacheDir, createHash('sha256').update(`${job.meetingId}:${job.participantId}`).digest('hex') + '.json');
    let cache = [];
    try { const entries = JSON.parse(readFileSync(cacheFile, 'utf8')).entries; if (Array.isArray(entries)) cache = entries; } catch { /* A missing cache is harmless. */ }
    const keys = validated.segments.map(segment => createHash('sha256').update(JSON.stringify({ model, segment })).digest('hex'));
    const cached = keys.map(key => cache.find(entry => entry.key === key && entry.vector?.length === model.dimensions && entry.vector.every(Number.isFinite)));
    const missing = validated.segments.filter((_, index) => !cached[index]);
    let raw = [];
    if (missing.length) {
      const paths = await extractClips(job, { ...validated, segments: missing }, signal);
      raw = await runtime.extract(paths, { signal });
      signal.throwIfAborted();
      if (raw.length !== paths.length || raw.some(vector => vector.length !== model.dimensions)) throw failure('声纹模型返回的特征维度不符。');
    }
    let next = 0;
    const vectors = cached.map(entry => normalize(entry?.vector || raw[next++]));
    const current = validateSources(job.input, { enrollment: job.type === 'enroll' });
    if (JSON.stringify(current.segments) !== JSON.stringify(validated.segments) || current.participant.memberId !== validated.participant.memberId) throw failure('提取期间发言或说话人归属有修改，请重新选择样本。');
    const fresh = keys.map((key, index) => ({ key, vector: vectors[index] }));
    cache = [...fresh, ...cache.filter(entry => !keys.includes(entry.key))].slice(0, 8);
    await writeFile(cacheFile, JSON.stringify({ entries: cache }), { mode: 0o600 });
    signal.throwIfAborted();
    const consistency = Math.min(...vectors.flatMap((vector, index) => vectors.slice(index + 1).map(other => cosine(vector, other))));
    const embedding = centroid(vectors);
    if (job.type === 'enroll') {
      if (consistency < 0.5) throw failure('这些片段的声音差异较大，请重新选择同一人的清晰发言。');
      const profile = { id: randomUUID(), scope: validated.scope, meetingId: job.meetingId, participantId: job.participantId, memberId: validated.scope === 'team' ? validated.participant.memberId : null, name: validated.participant.name, author: 'host', enabled: true, model, sourceIds: validated.sourceIds, segments: validated.segments, embedding, vectors, consistency, createdAt: now() };
      save(profilesDir, profile); profiles.set(profile.id, profile);
      return { status: 'enrolled', profile: publicProfile(profile), calibrated: false, message: '声音样本已保存，可用于识别后续发言。' };
    }
    const context = { model };
    const eligible = [...profiles.values()].filter(profile => sameModel(profile.model, model) && !(profile.scope === 'meeting' && profile.participantId === job.participantId)).map(profile => ({ profile, public: publicProfile(profile, job.meetingId, context) })).filter(item => item.public.available);
    const rank = vector => {
      const grouped = new Map();
      for (const { profile, public: metadata } of eligible) {
        const key = voiceprintIdentityKey(profile), score = cosine(vector, profile.embedding);
        if (!Number.isFinite(score)) continue;
        if (!grouped.has(key) || grouped.get(key).score < score) grouped.set(key, { ...metadata, score: Math.max(-1, Math.min(1, score)) });
      }
      return [...grouped.values()].sort((a, b) => b.score - a.score);
    };
    const ranked = rank(embedding), best = ranked[0];
    const segmentMatches = vectors.map((vector, index) => {
      const candidates = rank(vector);
      return { sourceId: validated.segments[index].sourceId, candidates: candidates.slice(0, 3), margin: candidates[0] ? candidates[0].score - (candidates[1]?.score ?? 0) : 0, marginBasis: candidates.length > 1 ? 'runner_up' : 'neutral_cosine' };
    });
    const margin = best ? best.score - (ranked[1]?.score ?? 0) : 0;
    const autoAccept = assessAutoMatch({ ranked, segmentMatches, consistency });
    const strongCandidate = best && best.score >= VOICEPRINT_POLICY.candidateMinimumCosine && margin >= VOICEPRINT_POLICY.candidateMinimumMargin && consistency >= 0.5;
    return { status: strongCandidate ? 'candidate' : 'unknown', candidates: ranked.filter(item => item.score >= VOICEPRINT_POLICY.candidateMinimumCosine).slice(0, 3), segmentMatches, consistency, margin, marginBasis: ranked.length > 1 ? 'runner_up' : 'neutral_cosine', autoAccept, policy: VOICEPRINT_POLICY, calibrated: false, model, scoreKind: 'cosine_similarity', cacheHits: cached.filter(Boolean).length, reason: strongCandidate ? null : !best ? 'no_profiles' : 'ambiguous_or_weak', message: autoAccept ? '多段声音一致，可按试用阈值采用姓名；仍可随时纠正。' : '声音还不够确定，继续积累发言或由主持人确认。相似度不是身份概率。' };
  }
  async function pump() {
    if (running || stopped) return;
    const job = queue.shift();
    if (!job) return;
    if (job.status !== 'queued') return void pump();
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    running = { job, controller, done };
    updateJob(job, { status: 'running' });
    const timer = setTimeout(() => controller.abort(new Error('声纹处理超时。')), timeoutMs);
    try { const result = await run(job, controller.signal); if (job.status !== 'cancelled') updateJob(job, { status: 'done', result, error: null }); }
    catch (error) { if (job.status !== 'cancelled') updateJob(job, { status: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? '声纹任务超时或已取消，仍可手动标记说话人。' : error.code === 'ENOENT' ? '所选发言的本地录音文件不存在，仍可手动标记。' : error.message }); }
    finally { clearTimeout(timer); running = null; resolveDone(); if (!stopped) queueMicrotask(pump); }
  }
  function submit(type, input = {}) {
    if (!['enroll', 'match'].includes(type)) throw failure('声纹任务类型无效。');
    if (stopped) throw failure('声纹服务已停止。', 503);
    if (!runtime.status().available) throw failure('尚未安装本地声纹运行时，仍可手动标记说话人。', 409);
    const clean = { meetingId: input.meetingId, participantId: input.participantId, sourceIds: input.sourceIds, scope: input.scope || 'meeting', automatic: type === 'match' && input.automatic === true };
    const validated = validateSources(clean, { enrollment: type === 'enroll' });
    clean.sourceIds = validated.sourceIds;
    const existing = [...jobs.values()].find(job => ['queued', 'running'].includes(job.status) && job.type === type && JSON.stringify(job.input) === JSON.stringify(clean));
    if (existing) return clone(existing);
    const job = { id: randomUUID(), type, meetingId: clean.meetingId, participantId: clean.participantId, automatic: clean.automatic, input: clean, status: 'queued', createdAt: now(), updatedAt: now(), result: null, error: null };
    jobs.set(job.id, job); save(jobsDir, job); queue.push(job); queueMicrotask(pump); return clone(job);
  }
  function getJob(id) { const job = jobs.get(id); if (!job) throw failure('声纹任务不存在。', 404); return clone(job); }
  function listJobs({ meetingId, limit = 50 } = {}) {
    if (meetingId) store.getMeeting(meetingId);
    return [...jobs.values()].reverse().filter(job => !meetingId || job.meetingId === meetingId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(100, Math.max(1, Number(limit) || 50))).map(clone);
  }
  function cancelJob(id) {
    const job = jobs.get(id); if (!job) throw failure('声纹任务不存在。', 404);
    if (['queued', 'running'].includes(job.status)) { updateJob(job, { status: 'cancelled', error: '声纹任务已取消。' }); if (running?.job.id === id) running.controller.abort(); }
    return clone(job);
  }
  async function stop() {
    stopped = true;
    const done = running?.done;
    for (const job of jobs.values()) if (['queued', 'running'].includes(job.status)) cancelJob(job.id);
    await done;
  }
  function status() {
    const context = {}, all = [...profiles.values()], usable = all.filter(profile => profileAvailable(profile, profile.meetingId, context));
    return { ...runtime.status(), mode: 'automatic_with_review', calibrated: false, pendingJobs: [...jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length, profileCount: all.length, availableProfileCount: usable.length, availableTeamProfileCount: usable.filter(profile => profile.scope === 'team').length, sampleRequirements: { minSegments: 2, maxSegments: MAX_SEGMENTS, minSegmentSeconds: MIN_SEGMENT_SECONDS, maxSegmentSeconds: MAX_SEGMENT_SECONDS, minTotalSeconds: MIN_TOTAL_SECONDS, minCharacters: VOICEPRINT_POLICY.minCharacters }, candidatePolicy: { minimumCosine: VOICEPRINT_POLICY.candidateMinimumCosine, minimumMargin: VOICEPRINT_POLICY.candidateMinimumMargin, calibrated: false }, automaticPolicy: VOICEPRINT_POLICY };
  }
  return { submit, getJob, listJobs, cancelJob, status, listProfiles, setProfileEnabled, selectSamples, stop };
}
