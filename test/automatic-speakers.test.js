import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAutomaticSpeakerService } from '../server/voiceprints/automatic.js';
import { isVoiceprintTextEligible } from '../shared/voiceprint-policy.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let index = 0; index < 200; index++) { if (predicate()) return; await pause(5); }
  assert.fail('Automatic identification did not settle');
}
function fixture(t, options = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'automatic-speakers-')));
  const meeting = store.createMeeting({ title: '自动识别验证' });
  const recording = store.createRecording(meeting.id);
  store.updateRecording(recording.id, { sampleCount: 16000 * 1000 });
  const member = store.createMember({ name: '陈工' });
  const profile = { id: 'profile-chen', scope: 'team', memberId: member.id, name: member.name, score: 0.94 };
  const submitted = [], refreshes = [], jobs = new Map();
  const data = { profiles: [profile], result: { status: 'candidate', candidates: [profile], autoAccept: profile }, pending: false, available: true };
  const voiceprints = {
    status: () => ({ available: data.available }), listProfiles: () => structuredClone(data.profiles),
    selectSamples: (id, participantId, { excludeSourceIds = [] } = {}) => {
      const lines = store.allTranscript(id).filter(line => line.participantId === participantId && !excludeSourceIds.includes(line.id) &&
        line.recordingId && line.timing !== 'chunk' && line.endSample - line.startSample >= 48000 && isVoiceprintTextEligible(line.text))
        .sort((a, b) => (b.endSample - b.startSample) - (a.endSample - a.startSample)).slice(0, 4);
      return lines.length >= 2 ? lines.map(line => line.id) : [];
    },
    submit: (type, input) => {
      submitted.push({ type, input });
      const job = { id: `job-${submitted.length}`, type, input, status: data.pending ? 'running' : 'done', result: structuredClone(data.result) };
      jobs.set(job.id, job); return structuredClone(job);
    },
    getJob: id => structuredClone(jobs.get(id)),
    cancelJob: id => { const job = jobs.get(id); if (job && ['queued', 'running'].includes(job.status)) job.status = 'cancelled'; return job; },
  };
  const ai = { refreshSpeakers: (...args) => refreshes.push(args) };
  const automatic = createAutomaticSpeakerService({ store, voiceprints, ai, debounceMs: 2, pollMs: 2, retryDelayMs: 5, ...options });
  t.after(async () => { await automatic.stop(); store.close(); });
  let seconds = 0;
  function append(speakerId = 'live-session-a-speaker-1', text = '这是完整清晰发言', duration = 4) {
    const line = store.appendTranscript(meeting.id, { text, speakerId, recordingId: recording.id, startSample: seconds * 16000, endSample: (seconds + duration) * 16000 });
    seconds += duration + 1;
    return line;
  }
  const person = id => store.listParticipants(meeting.id).find(item => item.id === id);
  return { store, meeting, recording, member, profile, data, voiceprints, ai, automatic, submitted, jobs, refreshes, append, person };
}

test('a stable ASR cluster is identified once and subsequent short utterances inherit its name', async t => {
  const f = fixture(t), first = f.append(), second = f.append();
  f.store.mutateMeeting(f.meeting.id, meeting => {
    meeting.processedRevision = meeting.transcriptRevision;
    meeting.topics = [{ id: 'topic', entries: [{ id: 'entry', evidenceIds: [first.id], text: '观点仍然保留', stale: false }] }];
  });
  const revision = f.store.getMeeting(f.meeting.id).transcriptRevision;
  f.automatic.start();
  for (let i = 0; i < 20; i++) f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].input.automatic, true);
  assert.deepEqual(f.submitted[0].input.sourceIds, [first.id, second.id]);
  const third = f.append(undefined, '好', 1); f.automatic.notify(f.meeting.id);
  await pause(20);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.person(third.participantId).memberId, f.member.id);
  assert.equal(f.person(third.participantId).name, '陈工');
  assert.deepEqual(f.refreshes[0], [f.meeting.id, [first.id, second.id], { kind: 'attribution' }]);
  const meeting = f.store.getMeeting(f.meeting.id);
  assert.equal(meeting.topics[0].entries[0].stale, false);
  assert.equal(meeting.topics[0].entries[0].identityReview, true);
  assert.equal(meeting.processedRevision, revision);
});

test('unknown placeholders, already named guests and three-character clips are not submitted', async t => {
  const f = fixture(t);
  f.append('unknown'); f.append('unknown');
  const guest = f.append('guest'); f.append('guest');
  f.store.updateParticipant(f.meeting.id, guest.participantId, { name: '来宾' });
  const waiting = f.append('short', '对，好呀！', 5); f.append('short', '甲乙丙', 5);
  f.append('short', '四个汉字', 2.5); f.append('short', 'one!', 5);
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(waiting.participantId).recognition?.status === 'waiting');
  assert.equal(f.submitted.length, 0);
  f.append('short', '四个汉字', 3); f.append('short', 'A，B。C！4', 3);
  f.automatic.notify(f.meeting.id);
  await until(() => f.person(waiting.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted[0].input.sourceIds.length, 2);
  assert.equal(f.person(guest.participantId).identitySource, 'manual');
});

test('uncertain matches wait for genuinely new eligible speech, then retry with that speech', async t => {
  const f = fixture(t); f.data.result.autoAccept = null;
  const first = f.append(undefined, '第一段完整发言', 20); f.append(undefined, '第二段完整发言', 20);
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.status === 'candidate');
  for (let i = 0; i < 20; i++) f.automatic.notify(f.meeting.id);
  await pause(25);
  assert.equal(f.submitted.length, 1);
  f.append(undefined, '嗯，好', 5); f.automatic.notify(f.meeting.id);
  await pause(15); assert.equal(f.submitted.length, 1);
  const fresh = f.append(undefined, '第三段完整发言', 4);
  f.data.result.autoAccept = f.profile; f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted.length, 2);
  assert.ok(f.submitted[1].input.sourceIds.includes(fresh.id));
});

test('repeated uncertainty is bounded and a host retry can explicitly reset the attempt budget', async t => {
  const f = fixture(t, { maxAttempts: 2 }); f.data.result = { status: 'unknown', candidates: [], autoAccept: null };
  const first = f.append(); f.append();
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.attempts === 1);
  f.append(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.attempts === 2);
  f.append(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.status === 'exhausted');
  assert.equal(f.submitted.length, 2);
  f.data.result = { status: 'candidate', candidates: [f.profile], autoAccept: f.profile };
  f.automatic.retry(f.meeting.id, first.participantId);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted.length, 3);
});

test('host naming during an in-flight comparison wins permanently over the late candidate', async t => {
  const f = fixture(t); f.data.pending = true;
  const first = f.append(); f.append();
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.submitted.length === 1);
  f.store.updateParticipant(f.meeting.id, first.participantId, { name: '主持人确认的来宾' });
  f.jobs.get('job-1').status = 'done';
  await pause(20);
  assert.equal(f.person(first.participantId).name, '主持人确认的来宾');
  assert.equal(f.person(first.participantId).identitySource, 'manual');
  assert.equal(f.person(first.participantId).recognition.status, 'confirmed');
  assert.equal(f.refreshes.length, 0);
  assert.throws(() => f.automatic.retry(f.meeting.id, first.participantId), /不需要重复识别/);
});

test('a confirmed one-line correction and profile invalidation each prevent a stale match from applying', async t => {
  for (const cause of ['line', 'profile']) await t.test(cause, async sub => {
    const f = fixture(sub); f.data.pending = true;
    const first = f.append(); f.append();
    f.automatic.start(); f.automatic.notify(f.meeting.id);
    await until(() => f.submitted.length === 1);
    if (cause === 'line') {
      const { participant } = f.store.createParticipant(f.meeting.id, { name: '另一个人' });
      f.store.assignTranscriptParticipant(f.meeting.id, first.id, participant.id);
    } else f.data.profiles = [];
    f.jobs.get('job-1').status = 'done';
    await until(() => !['queued', 'running'].includes(f.person(first.participantId).recognition.status));
    assert.equal(f.person(first.participantId).memberId, null);
    assert.equal(f.refreshes.length, 0);
  });
});

test('a reconnected ASR speaker has its own lookup; same number never inherits the previous name', async t => {
  const f = fixture(t), first = f.append(); f.append();
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  const reconnected = f.append('live-session-b-speaker-1');
  assert.notEqual(reconnected.participantId, first.participantId);
  assert.equal(f.person(reconnected.participantId).name, '');
  f.append('live-session-b-speaker-1'); f.automatic.notify(f.meeting.id);
  await until(() => f.person(reconnected.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted.length, 2);
});

test('visitor matches remain suggestions even when the matcher says its scores are strong', async t => {
  const f = fixture(t);
  const guest = { id: 'guest-profile', scope: 'meeting', meetingId: f.meeting.id, participantId: 'guest', name: '来宾', score: 0.99 };
  f.data.profiles = [guest]; f.data.result = { candidates: [guest], autoAccept: guest };
  const first = f.append(); f.append(); f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.status === 'candidate');
  assert.equal(f.person(first.participantId).name, '');
  assert.equal(f.person(first.participantId).mergedInto, undefined);
});

test('starting the service does not scan old meetings; pending state is recovered lazily on notification', async t => {
  const f = fixture(t), first = f.append(), second = f.append();
  f.store.updateMeeting(f.meeting.id, { status: 'ended' });
  f.store.setParticipantRecognition(f.meeting.id, first.participantId, {
    status: 'running', jobId: 'persisted-job', attempts: 1, sourceIds: [first.id, second.id],
    triedSources: Object.fromEntries([first, second].map(line => [line.id, `${line.revision}:${line.recordingId}:${line.startSample}:${line.endSample}`])),
  });
  f.jobs.set('persisted-job', { id: 'persisted-job', status: 'done', input: { sourceIds: [first.id, second.id] }, result: f.data.result });
  f.automatic.start(); await pause(20);
  assert.equal(f.person(first.participantId).name, '');
  assert.equal(f.person(first.participantId).recognition.status, 'running');
  f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  assert.equal(f.submitted.length, 0);
});

test('missing runtime is non-blocking and a failed AI refresh cannot undo a recognized name', async t => {
  const f = fixture(t); f.data.available = false;
  const first = f.append(); f.append(); f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).recognition?.status === 'unavailable');
  assert.equal(f.submitted.length, 0);
  f.data.available = true; f.ai.refreshSpeakers = () => { throw new Error('LLM offline'); };
  f.automatic.notify(f.meeting.id);
  await until(() => f.person(first.participantId).identitySource === 'voiceprint');
  assert.equal(f.person(first.participantId).name, '陈工');
  assert.equal(f.person(first.participantId).recognition.analysisStatus, 'error');
  assert.equal(f.person(first.participantId).recognition.analysisError, 'LLM offline');
});

test('a manual recognition request is limited to the chosen speaker and rejects missing participants', async t => {
  const f = fixture(t);
  const chosen = f.append('chosen'); f.append('chosen');
  const untouched = f.append('other'); f.append('other');
  f.store.updateMeeting(f.meeting.id, { status: 'ended' });
  f.automatic.start();
  assert.throws(() => f.automatic.retry(f.meeting.id, 'missing'), error => error.status === 404);
  f.automatic.retry(f.meeting.id, chosen.participantId);
  await until(() => f.person(chosen.participantId).identitySource === 'voiceprint');
  await pause(15);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.person(untouched.participantId).name, '');
  assert.equal(f.person(untouched.participantId).recognition, undefined);
});

test('shutdown cancels optional recognition without changing any manual identity or transcript', async t => {
  const f = fixture(t); f.data.pending = true;
  const first = f.append(); f.append();
  const before = f.store.rawTranscript(f.meeting.id);
  f.automatic.start(); f.automatic.notify(f.meeting.id);
  await until(() => f.submitted.length === 1);
  await f.automatic.stop();
  assert.equal(f.jobs.get('job-1').status, 'cancelled');
  assert.equal(f.person(first.participantId).name, '');
  assert.deepEqual(f.store.rawTranscript(f.meeting.id), before);
});
