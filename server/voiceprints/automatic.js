import { canRecognizeParticipant } from '../people/store.js';
import { isVoiceprintTextEligible, VOICEPRINT_POLICY } from '../../shared/voiceprint-policy.js';

const terminal = new Set(['done', 'error', 'cancelled']);
const signature = line => `${line.revision}:${line.recordingId}:${line.startSample}:${line.endSample}`;

// ASR owns the cluster; we identify it once and keep the name on its stable local
// participant. No model work runs on the audio ingestion or transcript callback.
export function createAutomaticSpeakerService({
  store, voiceprints, ai, debounceMs = 3000, pollMs = 500, retryDelayMs = 30000,
  maxAttempts = 4, jobTimeoutMs = 180000,
} = {}) {
  const pending = new Map();
  const targets = new Map();
  const timers = new Map();
  const sleepTimers = new Map();
  let started = false, stopped = false, processing = null, activeJobId = null;

  function arm(meetingId) {
    if (!started || stopped || !pending.has(meetingId)) return;
    clearTimeout(timers.get(meetingId));
    const timer = setTimeout(() => {
      timers.delete(meetingId);
      // Timers can fire just before the wall-clock deadline on some runtimes.
      if ((pending.get(meetingId) || 0) > Date.now()) arm(meetingId);
      else kick();
    }, Math.max(1, pending.get(meetingId) - Date.now()));
    timer.unref?.(); timers.set(meetingId, timer);
  }
  function schedule(meetingId, delay = debounceMs, participantId = null) {
    if (stopped) return;
    if (!participantId) targets.set(meetingId, null);
    else if (!targets.has(meetingId)) targets.set(meetingId, new Set([participantId]));
    else targets.get(meetingId)?.add(participantId);
    const due = Date.now() + Math.max(0, delay);
    if (pending.has(meetingId) && pending.get(meetingId) <= due) return;
    pending.set(meetingId, due);
    arm(meetingId);
  }
  function sleep(duration) {
    if (stopped) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { sleepTimers.delete(timer); resolve(); }, duration);
      timer.unref?.(); sleepTimers.set(timer, resolve);
    });
  }
  function person(meetingId, participantId) {
    return store.getMeeting(meetingId).participants.find(item => item.id === participantId);
  }
  const state = (meetingId, participantId, patch) => store.setParticipantRecognition(meetingId, participantId, patch);
  function eligibleLines(meetingId, participantId) {
    return store.allTranscript(meetingId).filter(line => line.participantId === participantId && line.recordingId &&
      line.timing !== 'chunk' && Number.isSafeInteger(line.startSample) && Number.isSafeInteger(line.endSample) &&
      line.endSample - line.startSample >= VOICEPRINT_POLICY.minSegmentSeconds * 16000 && isVoiceprintTextEligible(line.text));
  }
  function selectSources(meetingId, participantId, eligible, recognition) {
    const tried = recognition.triedSources || {};
    const fresh = eligible.filter(line => tried[line.id] !== signature(line));
    if (!fresh.length) return [];
    const reused = eligible.filter(line => tried[line.id] === signature(line)).sort((a, b) => (b.endSample - b.startSample) - (a.endSample - a.startSample));
    const select = excludeSourceIds => {
      const selected = voiceprints.selectSamples(meetingId, participantId, { automatic: true, excludeSourceIds });
      const ids = Array.isArray(selected) ? selected : selected?.sourceIds || [];
      return ids.length >= VOICEPRINT_POLICY.minSegments && ids.some(id => fresh.some(line => line.id === id)) ? ids : [];
    };
    let sourceIds = select(reused.map(line => line.id));
    if (sourceIds.length) return sourceIds;
    // One newly completed utterance can be checked with an earlier clear one.
    // Do not let sorting by duration repeatedly select only the old long clips.
    for (const partner of reused.slice(0, VOICEPRINT_POLICY.maxSegments)) {
      sourceIds = select(reused.filter(line => line.id !== partner.id).map(line => line.id));
      if (sourceIds.length) return sourceIds;
    }
    return [];
  }
  function validCandidates(meetingId, result) {
    const profiles = voiceprints.listProfiles({ meetingId });
    const available = candidate => profiles.some(profile => profile.id === candidate.id && profile.scope === candidate.scope &&
      (candidate.scope === 'team' ? profile.memberId === candidate.memberId : profile.participantId === candidate.participantId && profile.meetingId === meetingId));
    const candidates = (result?.candidates || []).filter(available).slice(0, 3);
    const proposed = result?.autoAccept === true ? candidates[0] : result?.autoAccept;
    const accepted = proposed?.scope === 'team' && available(proposed) ? proposed : null;
    return { candidates, accepted };
  }
  async function finish(meetingId, participantId, job) {
    if (stopped || !canRecognizeParticipant(person(meetingId, participantId))) return;
    if (job.status !== 'done') {
      state(meetingId, participantId, { status: 'error', error: job.error || '声音识别未完成', message: '暂未识别，等新的清晰发言再试', nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString() });
      return;
    }
    const recognition = person(meetingId, participantId).recognition || {};
    const currentLines = eligibleLines(meetingId, participantId);
    const sources = job.input?.sourceIds || recognition.sourceIds || [];
    if (sources.length < VOICEPRINT_POLICY.minSegments || sources.some(id => !currentLines.some(line => line.id === id && signature(line) === recognition.triedSources?.[id]))) {
      state(meetingId, participantId, { status: 'error', candidates: [], candidate: null, error: '用于识别的发言已有修改', message: '发言已修改，等待新的清晰发言', nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString() });
      return;
    }
    const { candidates, accepted } = validCandidates(meetingId, job.result);
    if (accepted) {
      const saved = store.applyRecognizedParticipant(meetingId, participantId, accepted, {
        expectedJobId: job.id, recognition: { jobId: job.id, sourceIds: job.input?.sourceIds || [], segmentMatches: job.result.segmentMatches || [], policy: job.result.policy || null },
      });
      if (saved.applied && saved.affectedSourceIds.length) {
        try {
          const refreshJob = await ai?.refreshSpeakers?.(meetingId, saved.affectedSourceIds, { kind: 'attribution' });
          state(meetingId, participantId, { analysisStatus: refreshJob?.status || 'done', analysisJobId: refreshJob?.id || null, analysisError: refreshJob?.error || null });
        } catch (error) {
          // The name is durable while a failed analysis refresh stays visible to
          // operators; it is never presented as successfully rewritten content.
          state(meetingId, participantId, { analysisStatus: 'error', analysisJobId: null, analysisError: error.message || '相关分析暂未完成核对' });
        }
      }
      if (saved.applied) return;
    }
    state(meetingId, participantId, {
      status: candidates.length ? 'candidate' : 'unknown', candidates, candidate: null, error: null,
      message: candidates.length ? '有相近的声音，等待确认或更多发言' : '暂未认出，再等几句清晰发言',
      nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString(),
      segmentMatches: job.result?.segmentMatches || [], policy: job.result?.policy || null,
    });
  }
  async function followJob(meetingId, participantId, initial) {
    activeJobId = initial.id;
    let job = initial;
    const deadline = Date.now() + jobTimeoutMs;
    while (!stopped && !terminal.has(job.status)) {
      if (!canRecognizeParticipant(person(meetingId, participantId))) {
        voiceprints.cancelJob?.(job.id); activeJobId = null; return;
      }
      if (Date.now() > deadline) {
        voiceprints.cancelJob?.(job.id);
        job = { ...job, status: 'error', error: '声音识别等待超时' }; break;
      }
      state(meetingId, participantId, { status: job.status === 'running' ? 'running' : 'queued' });
      await sleep(pollMs);
      if (!stopped) job = voiceprints.getJob(job.id);
    }
    activeJobId = null;
    if (!stopped) await finish(meetingId, participantId, job);
  }
  async function checkParticipant(meetingId, participantId, availability) {
    let participant = person(meetingId, participantId);
    if (!canRecognizeParticipant(participant)) return;
    let recognition = participant.recognition || {};
    // Restart recovery is lazy: only a meeting receiving a new notification is
    // revisited. We never scan old ended meetings or rewrite their identities.
    if (['queued', 'running'].includes(recognition.status) && recognition.jobId) {
      try { await followJob(meetingId, participantId, voiceprints.getJob(recognition.jobId)); }
      catch (error) { state(meetingId, participantId, { status: 'error', error: error.message, message: '等待新的发言后重试' }); }
      participant = person(meetingId, participantId);
      if (!canRecognizeParticipant(participant)) return;
      recognition = participant.recognition || {};
    }
    if (!availability.available) { state(meetingId, participantId, { status: 'unavailable', message: '本地声音识别尚未就绪', error: null }); return; }
    if (!availability.hasProfiles) { state(meetingId, participantId, { status: 'waiting', message: '还没有可用的声音样本', error: null }); return; }
    if ((recognition.attempts || 0) >= maxAttempts) {
      state(meetingId, participantId, { status: recognition.candidates?.length ? 'candidate' : 'exhausted', message: '还不能确定是谁，可手动标记或重新识别' }); return;
    }
    const eligible = eligibleLines(meetingId, participantId);
    if (eligible.length < VOICEPRINT_POLICY.minSegments) {
      if (!recognition.attempts) state(meetingId, participantId, { status: 'waiting', message: '再等几句清晰发言', error: null });
      return;
    }
    const sourceIds = selectSources(meetingId, participantId, eligible, recognition);
    if (!sourceIds.length) {
      if (!recognition.attempts) state(meetingId, participantId, { status: 'waiting', message: '再等几句清晰发言', error: null });
      return;
    }
    const retryAt = Date.parse(recognition.nextAttemptAt || '') || 0;
    if (retryAt > Date.now()) { schedule(meetingId, retryAt - Date.now(), participantId); return; }
    const triedSources = { ...(recognition.triedSources || {}) };
    for (const id of sourceIds) { const line = eligible.find(item => item.id === id); if (line) triedSources[id] = signature(line); }
    // Record the attempt before submission, so a synchronous sample rejection
    // cannot trigger the exact same expensive attempt on each ASR notification.
    state(meetingId, participantId, { status: 'queued', attempts: (recognition.attempts || 0) + 1, sourceIds, triedSources, triedSourceIds: Object.keys(triedSources), jobId: null, error: null, nextAttemptAt: null, message: '正在辨认声音' });
    try {
      const job = voiceprints.submit('match', { meetingId, participantId, sourceIds, automatic: true });
      state(meetingId, participantId, { jobId: job.id });
      await followJob(meetingId, participantId, job);
    } catch (error) {
      state(meetingId, participantId, { status: 'error', error: error.message, message: '暂未识别，等新的清晰发言再试', nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString() });
    }
  }
  async function drain() {
    while (started && !stopped) {
      const item = [...pending].find(([, due]) => due <= Date.now());
      if (!item) return;
      const [meetingId] = item;
      const requested = targets.get(meetingId);
      targets.delete(meetingId);
      pending.delete(meetingId); clearTimeout(timers.get(meetingId)); timers.delete(meetingId);
      try {
        const meeting = store.getMeeting(meetingId);
        if (meeting.archived) continue;
        const participants = (meeting.participants || []).filter(participant => canRecognizeParticipant(participant) && (!requested || requested.has(participant.id)));
        if (!participants.length) continue;
        const available = voiceprints.status().available;
        const availability = { available, hasProfiles: available && voiceprints.listProfiles({ meetingId }).length > 0 };
        for (const participant of participants) {
          if (stopped) return;
          try { await checkParticipant(meetingId, participant.id, availability); }
          catch { /* Recording continues even if optional recognition cannot run. */ }
        }
      } catch { /* A removed or unavailable meeting does not block others. */ }
    }
  }
  function kick() {
    if (!started || stopped || processing) return;
    processing = drain().finally(() => { processing = null; if (!stopped && [...pending.values()].some(due => due <= Date.now())) kick(); });
  }
  function start() {
    if (started || stopped) return;
    started = true;
    for (const meetingId of pending.keys()) arm(meetingId);
    kick();
  }
  function notify(meetingId) { schedule(meetingId); }
  function retry(meetingId, participantId) {
    const participant = person(meetingId, participantId);
    if (!participant) throw Object.assign(new Error('参会者不存在或不属于本次会议'), { status: 404 });
    if (!canRecognizeParticipant(participant)) throw Object.assign(new Error('这位说话人已标记姓名，不需要重复识别'), { status: 409 });
    if (['queued', 'running'].includes(participant.recognition?.status)) return participant.recognition;
    state(meetingId, participantId, { status: 'waiting', attempts: 0, sourceIds: [], triedSourceIds: [], triedSources: {}, jobId: null, nextAttemptAt: null, candidates: [], candidate: null, error: null, message: '等待辨认声音' });
    schedule(meetingId, 0, participantId);
    return person(meetingId, participantId).recognition;
  }
  async function stop() {
    stopped = true; started = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear(); pending.clear(); targets.clear();
    for (const [timer, resolve] of sleepTimers) { clearTimeout(timer); resolve(); }
    sleepTimers.clear();
    if (activeJobId) { try { voiceprints.cancelJob?.(activeJobId); } catch { /* Already completed. */ } }
    await processing;
  }
  return { start, notify, retry, stop };
}
