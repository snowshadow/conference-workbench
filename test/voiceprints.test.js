import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceprintService } from '../server/voiceprints/service.js';

const MODEL = { id: 'mock-campplus', revision: 'test-1', dimensions: 3 };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function complete(service, job) {
  for (let i = 0; i < 200; i++) { const value = service.getJob(job.id); if (!['queued', 'running'].includes(value.status)) return value; await pause(); }
  throw new Error('Fixture task did not settle');
}
function fixture(t, runtimeOverride = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'meeting-voiceprints-'));
  mkdirSync(path.join(dataDir, 'audio'));
  const meetings = new Map(), recordings = new Map(), members = new Map();
  const store = { dataDir, getMeeting: id => { const value = meetings.get(id); if (!value) throw new Error('Missing meeting'); return structuredClone(value); }, listParticipants: id => structuredClone(meetings.get(id).participants), allTranscript: id => structuredClone(meetings.get(id).lines), getRecording: id => structuredClone(recordings.get(id)), getMember: id => structuredClone(members.get(id)) };
  function speaker(meetingId, id, { manual = true, memberId = null, amplitude = 2000 } = {}) {
    if (!meetings.has(meetingId)) meetings.set(meetingId, { id: meetingId, participants: [], lines: [] });
    const meeting = meetings.get(meetingId);
    const participant = { id, name: id, memberId, speakerIds: [`speaker-${id}`], identitySource: manual ? 'manual' : 'asr', needsConfirmation: !manual };
    meeting.participants.push(participant);
    if (memberId) members.set(memberId, { id: memberId, name: `成员 ${memberId}` });
    const recordingId = `${meetingId}-${id}`;
    const pcm = Buffer.alloc(10 * 16000 * 2); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
    writeFileSync(path.join(dataDir, 'audio', `${recordingId}.pcm`), pcm);
    recordings.set(recordingId, { id: recordingId, meetingId, sampleCount: pcm.length / 2, sampleRate: 16000 });
    const lines = [0, 4].map((seconds, index) => ({ id: `${recordingId}-${index}`, meetingId, recordingId, participantId: id, speakerId: `speaker-${id}`, startSample: seconds * 16000, endSample: (seconds + 3) * 16000, revision: 1, text: '合成测试语音' }));
    meeting.lines.push(...lines);
    return { participant, lines, input: { meetingId, participantId: id, sourceIds: lines.map(line => line.id) } };
  }
  const runtime = { status: () => ({ available: true, model: MODEL }), extract: async paths => paths.map(filename => readFileSync(filename).readInt16LE(0) === 2000 ? [1, 0, 0] : [0, 1, 0]), ...runtimeOverride };
  const service = createVoiceprintService({ store, runtime, timeoutMs: 1000 });
  t.after(() => service.stop());
  return { dataDir, store, service, speaker, meetings, recordings, runtime };
}

test('manually enrolled team voiceprints provide cross-meeting candidates without changing identity', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known', { memberId: 'alice' });
  const guest = f.speaker('next', 'guest', { manual: false });
  const enrolled = await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  assert.equal(enrolled.status, 'done');
  assert.equal(enrolled.result.profile.scope, 'team');
  const matched = await complete(f.service, f.service.submit('match', guest.input));
  assert.equal(matched.result.status, 'candidate');
  assert.equal(matched.result.calibrated, false);
  assert.equal(matched.result.candidates[0].memberId, 'alice');
  assert.equal(matched.result.candidates[0].score, 1);
  assert.equal(guest.participant.memberId, null);
  assert.equal(guest.participant.identitySource, 'asr');
  assert.equal(f.service.listProfiles({ meetingId: 'next' }).length, 1);
  assert.equal(statSync(path.join(f.dataDir, 'voiceprints')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(f.dataDir, 'voiceprints', 'profiles', enrolled.result.profile.id + '.json')).mode & 0o777, 0o600);
});

test('visitor voiceprints are visible only inside the meeting that enrolled them', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'visitor');
  const sameMeeting = f.speaker('first', 'another-track', { manual: false });
  const otherMeeting = f.speaker('second', 'visitor', { manual: false });
  await complete(f.service, f.service.submit('enroll', known.input));
  assert.equal((await complete(f.service, f.service.submit('match', sameMeeting.input))).result.candidates[0].participantId, 'visitor');
  assert.equal((await complete(f.service, f.service.submit('match', otherMeeting.input))).result.status, 'unknown');
  assert.equal(f.service.listProfiles({ meetingId: 'second' }).length, 0);
});

test('enrollment requires an explicit human identity confirmation and a member for team scope', t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person', { manual: false });
  assert.throws(() => f.service.submit('enroll', p.input), /人工确认/);
  p.participant.identitySource = 'manual'; p.participant.needsConfirmation = false;
  assert.throws(() => f.service.submit('enroll', { ...p.input, scope: 'team' }), /关联到团队成员/);
});

test('unknown, chunk-timed, short and mixed participant samples are rejected before jobs start', t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person');
  assert.throws(() => f.service.submit('enroll', { ...p.input, sourceIds: [p.lines[0].id] }), /2–4/);
  p.lines[0].speakerId = 'unknown';
  assert.throws(() => f.service.submit('enroll', p.input), /未知发言/);
  p.lines[0].speakerId = 'speaker-person'; p.lines[0].timing = 'chunk';
  assert.throws(() => f.service.submit('enroll', p.input), /整块时间/);
  delete p.lines[0].timing; p.lines[0].endSample = 16000;
  assert.throws(() => f.service.submit('enroll', p.input), /至少需要 3 秒/);
  p.lines[0].endSample = 48000; p.lines[1].participantId = 'other-person';
  assert.throws(() => f.service.submit('enroll', p.input), /不属于同一位/);
});

test('explicit source reassignment permits enrollment despite a legacy unknown raw label', async t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person'); p.participant.speakerIds = [];
  for (const line of p.lines) { line.speakerId = 'unknown'; line.participantSource = 'host'; }
  const result = await complete(f.service, f.service.submit('enroll', p.input));
  assert.equal(result.status, 'done');
  assert.equal(result.result.profile.participantId, 'person');
});

test('long accurately timed turns use the first 30 seconds and retain original source bounds', async t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person');
  const rec = f.recordings.get(p.lines[0].recordingId);
  const pcm = Buffer.alloc(80 * 16000 * 2); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(2000, i);
  writeFileSync(path.join(f.dataDir, 'audio', rec.id + '.pcm'), pcm); rec.sampleCount = pcm.length / 2;
  p.lines[0].endSample = 40 * 16000; p.lines[1].startSample = 45 * 16000; p.lines[1].endSample = 80 * 16000;
  // Another speaker starts outside both extracted excerpts and must not block them.
  f.meetings.get('first').lines.push({ ...p.lines[0], id: 'later-overlap', participantId: 'other', startSample: 31 * 16000, endSample: 34 * 16000 });
  const result = await complete(f.service, f.service.submit('enroll', p.input));
  assert.equal(result.status, 'done');
  const profile = JSON.parse(readFileSync(path.join(f.dataDir, 'voiceprints', 'profiles', result.result.profile.id + '.json')));
  assert.equal(profile.segments[0].endSample, 30 * 16000);
  assert.equal(profile.segments[0].sourceEndSample, 40 * 16000);
  assert.equal(profile.segments[1].endSample, 75 * 16000);
  assert.equal(f.service.listProfiles({ meetingId: 'first' }).length, 1);
  p.lines[0].endSample += 1;
  assert.equal(f.service.listProfiles({ meetingId: 'first' }).length, 0);
});

test('overlapping speech and invalid recording boundaries cannot become enrollment samples', t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person');
  f.meetings.get('first').lines.push({ ...p.lines[0], id: 'overlap', participantId: 'other', startSample: 2000 });
  assert.throws(() => f.service.submit('enroll', p.input), /包含其他说话人/);
  f.meetings.get('first').lines.pop(); p.lines[1].endSample = 99 * 16000;
  assert.throws(() => f.service.submit('enroll', p.input), /录音位置无效/);
});

test('silence, clipping and inconsistent embeddings fail locally and preserve manual labeling', async t => {
  const f = fixture(t);
  const silent = f.speaker('first', 'quiet', { amplitude: 0 });
  assert.match((await complete(f.service, f.service.submit('enroll', silent.input))).error, /过于安静/);
  const clipped = f.speaker('first', 'loud', { amplitude: 32767 });
  assert.match((await complete(f.service, f.service.submit('enroll', clipped.input))).error, /失真/);
  const mixed = f.speaker('first', 'mixed'); f.runtime.extract = async () => [[1, 0, 0], [0, 1, 0]];
  assert.match((await complete(f.service, f.service.submit('enroll', mixed.input))).error, /差异较大/);
  assert.equal(f.service.listProfiles({ meetingId: 'first' }).length, 0);
  assert.equal(mixed.participant.name, 'mixed');
});

test('weak or ambiguous matches remain unknown instead of always choosing the highest score', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known', { memberId: 'a' });
  const other = f.speaker('first', 'other', { memberId: 'b' });
  const query = f.speaker('second', 'query', { manual: false, amplitude: 3000 });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  assert.equal((await complete(f.service, f.service.submit('match', query.input))).result.status, 'unknown');
  await complete(f.service, f.service.submit('enroll', { ...other.input, scope: 'team' }));
  f.runtime.extract = async paths => paths.map(() => [1, 0, 0]);
  const ambiguous = await complete(f.service, f.service.submit('match', query.input));
  assert.equal(ambiguous.result.status, 'unknown');
  assert.equal(ambiguous.result.reason, 'ambiguous_or_weak');
});

test('identity and source changes invalidate stale profiles rather than trusting old enrollment', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known', { memberId: 'a' });
  f.speaker('second', 'query', { manual: false });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  known.participant.memberId = 'different-member';
  assert.equal(f.service.listProfiles({ meetingId: 'second' }).length, 0);
  known.participant.memberId = 'a'; known.lines[0].participantId = 'different-person';
  assert.equal(f.service.listProfiles({ meetingId: 'second' }).length, 0);
});

test('source edits during extraction discard a late result', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known');
  f.runtime.extract = async paths => { known.lines[0].revision++; return paths.map(() => [1, 0, 0]); };
  const job = await complete(f.service, f.service.submit('enroll', known.input));
  assert.equal(job.status, 'error');
  assert.match(job.error, /提取期间/);
  assert.equal(f.service.listProfiles({ meetingId: 'first' }).length, 0);
});

test('clip extraction uses sample offsets rather than transcript order or whole recording audio', async t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person');
  const pcm = Buffer.alloc(10 * 16000 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i < 3 * 16000 * 2 ? 1111 : i >= 4 * 16000 * 2 && i < 7 * 16000 * 2 ? 2222 : -999, i);
  writeFileSync(path.join(f.dataDir, 'audio', p.lines[0].recordingId + '.pcm'), pcm);
  f.runtime.extract = async paths => {
    assert.deepEqual(paths.map(filename => readFileSync(filename).readInt16LE(0)), [1111, 2222]);
    assert.deepEqual(paths.map(filename => statSync(filename).size), [96000, 96000]);
    return paths.map(() => [1, 0, 0]);
  };
  assert.equal((await complete(f.service, f.service.submit('enroll', p.input))).status, 'done');
});

test('a timed out task is cancelled without registering a profile', async t => {
  const f = fixture(t);
  const p = f.speaker('first', 'person');
  const runtime = { ...f.runtime, extract: (paths, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })) };
  const service = createVoiceprintService({ store: f.store, runtime, timeoutMs: 20 }); t.after(() => service.stop());
  const job = await complete(service, service.submit('enroll', p.input));
  assert.equal(job.status, 'cancelled');
  assert.match(job.error, /超时或已取消/);
  assert.equal(service.listProfiles({ meetingId: 'first' }).length, 0);
});

test('missing runtime and worker failures leave the meeting usable', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known');
  f.runtime.status = () => ({ available: false, model: MODEL });
  assert.throws(() => f.service.submit('enroll', known.input), /仍可手动标记/);
  f.runtime.status = () => ({ available: true, model: MODEL });
  f.runtime.extract = async () => { throw new Error('Mock worker failure'); };
  const failed = await complete(f.service, f.service.submit('enroll', known.input));
  assert.equal(failed.status, 'error');
  assert.equal(known.participant.name, 'known');
});

test('jobs are serial, duplicate submissions deduplicate, and cancellation stops registration', async t => {
  let release, calls = 0;
  const f = fixture(t, { extract: (paths, { signal }) => new Promise((resolve, reject) => {
    calls++; release = () => resolve(paths.map(() => [1, 0, 0]));
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  const first = f.speaker('first', 'a'); const second = f.speaker('first', 'b');
  const a = f.service.submit('enroll', first.input);
  assert.equal(f.service.submit('enroll', first.input).id, a.id);
  const b = f.service.submit('enroll', second.input);
  while (!release) await pause();
  assert.equal(calls, 1); assert.equal(f.service.getJob(b.id).status, 'queued');
  f.service.cancelJob(a.id);
  while (calls < 2) await pause();
  release();
  assert.equal((await complete(f.service, b)).status, 'done');
  assert.equal(f.service.getJob(a.id).status, 'cancelled');
  assert.equal(f.service.listProfiles({ meetingId: 'first' }).length, 1);
});

test('a new service reloads profiles and filters embeddings from a different model revision', async t => {
  const f = fixture(t);
  const known = f.speaker('first', 'known', { memberId: 'a' });
  const query = f.speaker('second', 'query', { manual: false });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  await f.service.stop();
  const runtime = { ...f.runtime, status: () => ({ available: true, model: { ...MODEL, revision: 'test-2' } }) };
  const next = createVoiceprintService({ store: f.store, runtime }); t.after(() => next.stop());
  assert.equal(next.listProfiles({ meetingId: 'second' }).length, 0);
  assert.equal(next.listProfiles({ meetingId: 'second', includeUnavailable: true })[0].unavailableReason, 'model_changed');
  assert.equal((await complete(next, next.submit('match', query.input))).result.status, 'unknown');
});

test('automatic sample selection skips short text, partials, unknown clusters and overlapping excerpts', t => {
  const f = fixture(t), p = f.speaker('meeting', 'query', { manual: false });
  assert.deepEqual(f.service.selectSamples('meeting', 'query'), p.input.sourceIds);
  assert.deepEqual(f.service.selectSamples('meeting', 'query', { excludeSourceIds: [p.lines[0].id] }), []);
  for (const patch of [{ text: '好好好！' }, { final: false }, { timing: 'chunk' }, { speakerId: 'unknown' }, { endSample: 16000 }]) {
    const original = { ...p.lines[0] }; Object.assign(p.lines[0], patch);
    assert.deepEqual(f.service.selectSamples('meeting', 'query'), []);
    for (const key of Object.keys(p.lines[0])) delete p.lines[0][key]; Object.assign(p.lines[0], original);
  }
  f.meetings.get('meeting').lines.push({ ...p.lines[0], id: 'other-speaker', participantId: 'someone-else', startSample: 16000 });
  assert.deepEqual(f.service.selectSamples('meeting', 'query'), []);
  f.meetings.get('meeting').lines.pop();
  p.lines[1].startSample = 16000; p.lines[1].endSample = 4 * 16000;
  assert.deepEqual(f.service.selectSamples('meeting', 'query'), []);
});

test('automatic match chooses its own qualifying samples and returns per-segment evidence without binding anyone', async t => {
  const f = fixture(t), known = f.speaker('first', 'known', { memberId: 'alice' }), query = f.speaker('second', 'query', { manual: false });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  const matched = await complete(f.service, f.service.submit('match', { meetingId: 'second', participantId: 'query', automatic: true }));
  assert.equal(matched.automatic, true);
  assert.deepEqual(matched.input.sourceIds, query.input.sourceIds);
  assert.equal(matched.result.autoAccept.memberId, 'alice');
  assert.equal(matched.result.autoAccept.calibrated, false);
  assert.equal(matched.result.segmentMatches.length, 2);
  for (const segment of matched.result.segmentMatches) { assert.equal(segment.candidates[0].memberId, 'alice'); assert.equal(segment.marginBasis, 'neutral_cosine'); }
  assert.equal(query.participant.memberId, null);
});

test('an excellent aggregate cannot hide one weak utterance during automatic identification', async t => {
  const f = fixture(t), known = f.speaker('first', 'known', { memberId: 'alice' }), query = f.speaker('second', 'query', { manual: false });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  f.runtime.extract = async () => [[1, 0, 0], [0.79, 0.61, 0]];
  const matched = await complete(f.service, f.service.submit('match', { ...query.input, automatic: true }));
  assert.ok(matched.result.candidates[0].score > 0.9);
  assert.ok(matched.result.segmentMatches[1].candidates[0].score < 0.8);
  assert.equal(matched.result.autoAccept, null);
});

test('sample manager exposes playback metadata and unavailable reasons without exposing vectors or paths', async t => {
  const f = fixture(t), known = f.speaker('first', 'known', { memberId: 'alice' });
  const enrolled = await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  const id = enrolled.result.profile.id;
  let profiles = f.service.listProfiles({ includeUnavailable: true });
  assert.equal(profiles[0].available, true);
  assert.deepEqual(profiles[0].segments.map(segment => segment.sourceId), known.input.sourceIds);
  assert.doesNotMatch(JSON.stringify(profiles), /embedding|vectors|\/tmp\//);
  assert.equal(f.service.status().availableTeamProfileCount, 1);
  assert.equal(f.service.setProfileEnabled(id, false).unavailableReason, 'disabled');
  assert.equal(f.service.listProfiles().length, 0);
  assert.equal(f.service.status().availableTeamProfileCount, 0);
  assert.equal(f.service.setProfileEnabled(id, true).available, true);
  known.lines[0].participantId = 'corrected-person';
  assert.equal(f.service.listProfiles().length, 0);
  assert.equal(f.service.listProfiles({ includeUnavailable: true })[0].unavailableReason, 'source_changed');
  assert.equal(f.service.setProfileEnabled(id, true).available, false);
});

test('embedding reuse avoids repeated CPU work while source revisions invalidate only changed excerpts', async t => {
  const calls = [];
  const f = fixture(t, { extract: async paths => { calls.push(paths.length); return paths.map(() => [1, 0, 0]); } });
  const known = f.speaker('first', 'known', { memberId: 'alice' }), query = f.speaker('second', 'query', { manual: false });
  await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  await complete(f.service, f.service.submit('match', query.input));
  const repeated = await complete(f.service, f.service.submit('match', query.input));
  assert.deepEqual(calls, [2, 2]);
  assert.equal(repeated.result.cacheHits, 2);
  query.lines[0].revision++;
  await complete(f.service, f.service.submit('match', query.input));
  assert.deepEqual(calls, [2, 2, 1]);
  assert.equal(readdirSync(path.join(f.dataDir, 'voiceprints', 'samples')).length, 1);
  assert.ok(readdirSync(path.join(f.dataDir, 'voiceprints', 'samples', 'work')).length <= 4);
  await f.service.stop();
  const next = createVoiceprintService({ store: f.store, runtime: f.runtime }); t.after(() => next.stop());
  const resumed = await complete(next, next.submit('match', query.input));
  assert.equal(resumed.result.cacheHits, 2);
  assert.deepEqual(calls, [2, 2, 1]);
});

test('disabling a voiceprint during extraction prevents a late automatic suggestion from accepting it', async t => {
  const f = fixture(t), known = f.speaker('first', 'known', { memberId: 'alice' }), query = f.speaker('second', 'query', { manual: false });
  const enrolled = await complete(f.service, f.service.submit('enroll', { ...known.input, scope: 'team' }));
  f.runtime.extract = async paths => { f.service.setProfileEnabled(enrolled.result.profile.id, false); return paths.map(() => [1, 0, 0]); };
  const result = await complete(f.service, f.service.submit('match', { ...query.input, automatic: true }));
  assert.equal(result.result.reason, 'no_profiles');
  assert.equal(result.result.autoAccept, null);
});

test('job history is scoped and copied, and shutdown waits for a cancelled worker to unwind', async t => {
  let started = false, unwound = false;
  const f = fixture(t, { extract: (paths, { signal }) => new Promise((resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => setTimeout(() => { unwound = true; reject(new Error('worker stopped')); }, 20), { once: true });
  }) });
  const first = f.speaker('first', 'a'), second = f.speaker('second', 'b');
  const firstJob = f.service.submit('match', first.input), secondJob = f.service.submit('match', second.input);
  const history = f.service.listJobs({ meetingId: 'first' });
  assert.equal(history.length, 1); assert.equal(history[0].id, firstJob.id);
  history[0].status = 'done'; assert.equal(f.service.getJob(firstJob.id).status, 'queued');
  assert.equal(f.service.listJobs({ limit: 1 })[0].id, secondJob.id);
  while (!started) await pause();
  await f.service.stop();
  assert.equal(unwound, true);
  assert.equal(f.service.getJob(firstJob.id).status, 'cancelled');
  assert.equal(f.service.getJob(secondJob.id).status, 'cancelled');
  assert.equal(f.service.listProfiles().length, 0);
});

test('listing team samples reads each enrollment meeting once even with several profiles', async t => {
  const f = fixture(t), a = f.speaker('first', 'a', { memberId: 'a' }), b = f.speaker('first', 'b', { memberId: 'b' });
  await complete(f.service, f.service.submit('enroll', { ...a.input, scope: 'team' }));
  await complete(f.service, f.service.submit('enroll', { ...b.input, scope: 'team' }));
  let reads = 0; const read = f.store.allTranscript;
  f.store.allTranscript = (...args) => { reads++; return read(...args); };
  assert.equal(f.service.listProfiles().length, 2);
  assert.equal(reads, 1);
});
