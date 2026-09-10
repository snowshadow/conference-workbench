import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createWorkbench } from '../server/app.js';

async function fixture(t) {
  const refreshes = [], voiceCalls = [], profiles = [];
  const voiceJob = { id: 'voice-job', type: 'match', status: 'done', result: { candidates: [], calibrated: false } };
  const workbench = createWorkbench({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'meeting-people-api-')), aiFactory: () => ({
    start() {}, async stop() {}, submit() { throw new Error('没有配置 AI'); },
    refreshSpeakers(meetingId, sourceIds, options) { refreshes.push({ meetingId, sourceIds, ...options }); return { id: 'refresh-job', status: 'queued' }; },
  }), voiceprintFactory: () => ({
    status: () => ({ available: true, calibrated: false }), listProfiles: () => structuredClone(profiles), async stop() {},
    listJobs: () => [], setProfileEnabled(id, enabled) { const profile = profiles.find(item => item.id === id); profile.enabled = enabled; profile.available = enabled; return structuredClone(profile); },
    submit(type, input) { voiceCalls.push({ type, input }); return voiceJob; }, getJob: () => voiceJob, cancelJob: () => ({ ...voiceJob, status: 'cancelled' }),
  }) });
  workbench.server.listen(0, '127.0.0.1'); await once(workbench.server, 'listening');
  t.after(() => workbench.close());
  const base = `http://127.0.0.1:${workbench.server.address().port}`;
  async function request(resource, method = 'GET', body) {
    const response = await fetch(base + resource, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  return { workbench, request, base, refreshes, voiceCalls, profiles };
}

test('HTTP member naming propagates into AI views and export across meetings without rewriting host content', async t => {
  const { workbench: { store }, request, base, refreshes } = await fixture(t);
  const member = (await request('/api/members', 'POST', { name: '孙总' })).data;
  const meetings = [store.createMeeting({ title: '第一场' }), store.createMeeting({ title: '第二场' })];
  for (const meeting of meetings) {
    store.appendTranscript(meeting.id, { text: '建议分两期交付。', speakerId: 'cluster-one', origin: 'asr' });
    const person = store.listParticipants(meeting.id)[0];
    store.mutateMeeting(meeting.id, m => {
      m.topics = [{ id: 'topic', title: '交付', entries: [{ id: 'entry', type: 'viewpoint', status: 'active', author: 'ai', text: `[[person:${person.id}]]建议分两期交付。`, participantIds: [person.id] }] }];
      m.questions = [{ id: 'qa', author: 'ai', answer: `[[person:${person.id}]]提到了分期。` }];
      m.followups = [{ id: 'followup', status: 'recorded', resolution: { author: 'host', text: '孙总的说法需要继续核对。' } }];
      m.artifacts = [{ id: 'minutes', type: 'minutes', author: 'ai', markdown: `[[person:${person.id}]]：分两期。` }];
      m.processedRevision = m.transcriptRevision;
    });
    const saved = await request(`/api/meetings/${meeting.id}/participants/${person.id}`, 'PATCH', { memberId: member.id });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.meeting.topics[0].entries[0].text, '孙总建议分两期交付。');
    assert.equal(store.getMeeting(meeting.id).processedRevision, 1);
    assert.match(store.getMeeting(meeting.id).topics[0].entries[0].text, /\[\[person:/);
  }
  assert.ok(refreshes.every(item => item.kind === 'attribution'));
  refreshes.length = 0;
  assert.equal((await request(`/api/members/${member.id}`, 'PATCH', { name: '孙先生' })).status, 200);
  assert.equal(refreshes.length, 2);
  assert.ok(refreshes.every(item => item.kind === 'labels'));
  for (const meeting of meetings) {
    const current = (await request(`/api/meetings/${meeting.id}`)).data;
    assert.equal(current.questions[0].answer, '孙先生提到了分期。');
    assert.equal(current.artifacts[0].markdown, '孙先生：分两期。');
    assert.equal(current.followups[0].resolution.text, '孙总的说法需要继续核对。');
    const exported = await (await fetch(`${base}/api/meetings/${meeting.id}/export`)).text();
    assert.match(exported, /孙先生/); assert.doesNotMatch(exported, /\[\[person:/);
  }
});

test('HTTP corrects one unknown utterance and queues review for ended meetings without losing other sources', async t => {
  const { workbench: { store }, request, refreshes } = await fixture(t);
  const meeting = store.createMeeting({ title: '外部参会者' }), other = store.createMeeting({ title: '其他会议' });
  const first = store.appendTranscript(meeting.id, { text: '我赞成先验证。', speakerId: 'unknown', origin: 'asr' });
  const second = store.appendTranscript(meeting.id, { text: '这部分还不确定。', speakerId: 'unknown', origin: 'asr' });
  store.updateMeeting(meeting.id, { status: 'ended', processedRevision: 2 });
  const person = (await request(`/api/meetings/${meeting.id}/participants`, 'POST', { name: '客户张工' })).data;
  assert.ok(person.id);
  const assigned = await request(`/api/meetings/${meeting.id}/transcript/${first.id}/participant`, 'PATCH', { participantId: person.id, author: 'agent' });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.refreshJob.status, 'queued');
  assert.deepEqual(refreshes.at(-1), { meetingId: meeting.id, sourceIds: [first.id], kind: 'attribution' });
  const lines = store.allTranscript(meeting.id);
  assert.equal(lines[0].participantId, person.id); assert.equal(lines[0].text, first.text);
  assert.equal(lines[0].participantSource, 'agent');
  assert.notEqual(lines[1].participantId, person.id); assert.equal(lines[1].text, second.text);
  assert.equal(store.getMeeting(meeting.id).processedRevision, 2);
  assert.equal((await request(`/api/meetings/${other.id}/transcript/${first.id}/participant`, 'PATCH', { participantId: person.id })).status, 404);
});

test('speaker samples and voiceprint HTTP jobs use bounded audio ranges and separate local tasks', async t => {
  const { workbench: { store }, request, voiceCalls } = await fixture(t);
  const meeting = store.createMeeting({ title: '声音样本' });
  const recording = store.createRecording(meeting.id, { sampleCount: 16000 * 70, sampleRate: 16000 });
  const line = store.appendTranscript(meeting.id, { text: '一段较长的发言。', speakerId: 'one', origin: 'asr', recordingId: recording.id, startSample: 0, endSample: 16000 * 60 });
  const second = store.appendTranscript(meeting.id, { text: '另一段清晰发言。', speakerId: 'one', origin: 'asr', recordingId: recording.id, startSample: 16000 * 60, endSample: 16000 * 65 });
  const short = store.appendTranscript(meeting.id, { text: '嗯，好。', speakerId: 'one', origin: 'asr', recordingId: recording.id, startSample: 16000 * 65, endSample: 16000 * 69 });
  const people = (await request(`/api/meetings/${meeting.id}/people`)).data;
  assert.equal(people.participants[0].samples[0].endSample, 16000 * 30);
  assert.ok(people.participants[0].samples.every(sample => sample.id !== short.id), 'short utterances cannot be offered as voice samples');
  const person = people.participants[0];
  const endpoint = `/api/meetings/${meeting.id}/participants/${person.id}/voiceprints/match`;
  for (const sourceIds of [[], [line.id], [line.id, line.id], [line.id, ''], ['1','2','3','4','5']]) {
    assert.equal((await request(endpoint, 'POST', { sourceIds })).status, 400);
  }
  assert.equal(voiceCalls.length, 0);
  const response = await request(endpoint, 'POST', { sourceIds: [line.id, second.id] });
  assert.equal(response.status, 202); assert.equal(response.data.job.id, 'voice-job');
  assert.equal(voiceCalls.length, 1); assert.equal(voiceCalls[0].input.meetingId, meeting.id);
  assert.equal((await request('/api/voiceprint-jobs/voice-job')).data.job.status, 'done');
  assert.equal((await request('/api/voiceprints/status')).data.available, true);
  assert.equal((await request(`/api/meetings/${meeting.id}/participants/${person.id}/voiceprints/enroll`, 'POST', { sourceIds: [line.id, second.id], scope: 'global' })).status, 400);
  const automaticSelection = await request(endpoint, 'POST', {});
  assert.equal(automaticSelection.status, 202);
  assert.equal(voiceCalls.at(-1).input.sourceIds, undefined);
});

test('speaker utterances retain short speech and playable audio independently of voiceprint enrollment', async t => {
  const { workbench: { store }, request, base } = await fixture(t);
  const meeting = store.createMeeting({ title: '短句回听' });
  const recording = store.createRecording(meeting.id, { sampleCount: 16000 * 8 });
  const pcm = Buffer.alloc(16000 * 8 * 2, 12);
  writeFileSync(path.join(store.dataDir, 'audio', `${recording.id}.pcm`), pcm);
  const lines = [
    store.appendTranscript(meeting.id, { text: '嗯嗯。', speakerId: 'seven', recordingId: recording.id, startMs: 100, endMs: 700, startSample: 1600, endSample: 11200 }),
    store.appendTranscript(meeting.id, { text: '嗯，继续。', speakerId: 'seven', recordingId: recording.id, startMs: 1000, endMs: 2790, startSample: 16000, endSample: 44640 }),
    store.appendTranscript(meeting.id, { text: '还有一点需要补充。', speakerId: 'seven', recordingId: recording.id, startMs: 3000, endMs: 7000, startSample: 48000, endSample: 112000, timing: 'chunk' }),
  ];
  store.appendTranscript(meeting.id, { text: '另一位的发言不能混进来。', speakerId: 'other' });
  const person = (await request(`/api/meetings/${meeting.id}/people`)).data.participants.find(item => item.id === lines[0].participantId);
  assert.equal(person.lineCount, 3);
  assert.deepEqual(person.samples, [], 'short utterances and imprecise chunks remain ineligible for enrollment');
  const endpoint = `/api/meetings/${meeting.id}/participants/${person.id}/utterances`;
  const first = await request(`${endpoint}?limit=2`);
  assert.equal(first.status, 200);
  assert.equal(first.data.total, 3);
  assert.equal(first.data.nextCursor, 2);
  assert.deepEqual(first.data.lines.map(line => line.id), lines.slice(0, 2).map(line => line.id));
  assert.ok(first.data.lines.every(line => line.playbackAvailable));
  assert.equal(first.data.lines[0].text, '嗯嗯。');
  const audio = await fetch(`${base}/api/recordings/${recording.id}/audio?startSample=1600&endSample=11200`);
  assert.equal(audio.status, 200);
  const wav = Buffer.from(await audio.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(wav.subarray(44), pcm.subarray(3200, 22400), 'even a 0.6 second clip can be replayed');
  const second = (await request(`${endpoint}?cursor=${first.data.nextCursor}&limit=2`)).data;
  assert.equal(second.nextCursor, null);
  assert.equal(second.lines.length, 1);
  assert.equal(second.lines[0].playbackAvailable, true);
  assert.equal(second.lines[0].playbackLabel, '回听所在录音段');
  for (const query of ['cursor=-1', 'cursor=1.5', 'cursor=Infinity', 'cursor=9007199254740992', 'limit=0', 'limit=101', 'limit=nope']) assert.equal((await request(`${endpoint}?${query}`)).status, 400);
});

test('speaker utterances explain unavailable audio and follow corrected or merged identities', async t => {
  const { workbench: { store }, request } = await fixture(t);
  const meeting = store.createMeeting({ title: '只有文字的发言' });
  const recording = store.createRecording(meeting.id, { sampleCount: 16000 });
  const manual = store.appendTranscript(meeting.id, { text: '会后补充的文字。', speakerId: 'one', origin: 'host' });
  const noPosition = store.appendTranscript(meeting.id, { text: '没有时间位置的转录。', speakerId: 'one', recordingId: recording.id });
  const missingFile = store.appendTranscript(meeting.id, { text: '录音文件丢失。', speakerId: 'one', recordingId: recording.id, startSample: 0, endSample: 3200 });
  const other = store.appendTranscript(meeting.id, { text: '需要纠正归属的发言。', speakerId: 'two' });
  const endpoint = `/api/meetings/${meeting.id}/participants/${manual.participantId}/utterances`;
  const result = (await request(endpoint)).data;
  assert.equal(result.total, 3);
  assert.ok(result.lines.every(line => !line.playbackAvailable));
  assert.match(result.lines.find(line => line.id === manual.id).playbackReason, /只有文字/);
  assert.match(result.lines.find(line => line.id === noPosition.id).playbackReason, /录音位置/);
  assert.match(result.lines.find(line => line.id === missingFile.id).playbackReason, /无法读取/);
  writeFileSync(path.join(store.dataDir, 'audio', `${recording.id}.pcm`), Buffer.alloc(100));
  assert.equal((await request(endpoint)).data.lines.find(line => line.id === missingFile.id).playbackAvailable, false, 'incomplete files are not offered for replay');
  store.assignTranscriptParticipant(meeting.id, other.id, manual.participantId, { author: 'host' });
  assert.equal((await request(endpoint)).data.total, 4);
  const third = store.appendTranscript(meeting.id, { text: '后来确认是同一个人。', speakerId: 'three' });
  store.mergeParticipants(meeting.id, third.participantId, manual.participantId);
  assert.equal((await request(endpoint)).data.total, 5);
  assert.equal((await request(`/api/meetings/${meeting.id}/participants/${third.participantId}/utterances`)).data.total, 5);
  const elsewhere = store.createMeeting({ title: '别的会议' });
  assert.equal((await request(`/api/meetings/${elsewhere.id}/participants/${manual.participantId}/utterances`)).status, 404);
  assert.equal((await request(`/api/meetings/${meeting.id}/participants/missing/utterances`)).status, 404);
});

test('HTTP keeps speaker recognition state across reads and exposes reversible team sample management', async t => {
  const { workbench: { store }, request, profiles } = await fixture(t);
  const meeting = store.createMeeting({ title: '会议声音资料' });
  const line = store.appendTranscript(meeting.id, { text: '需要更多发言', speakerId: 'session-speaker-1' });
  const retry = `/api/meetings/${meeting.id}/participants/${line.participantId}/recognition/retry`;
  assert.equal((await request(retry, 'POST', {})).status, 202);
  const people = (await request(`/api/meetings/${meeting.id}/people`)).data;
  assert.ok(people.participants[0].recognition);
  store.updateParticipant(meeting.id, line.participantId, { name: '主持人确认的姓名' });
  assert.equal((await request(retry, 'POST', {})).status, 409);
  assert.equal((await request(`/api/meetings/${meeting.id}/participants/missing/recognition/retry`, 'POST', {})).status, 404);
  profiles.push({ id: 'sample', scope: 'team', name: '成员', meetingId: meeting.id, enabled: true, available: true, segments: [{ recordingId: 'recording', startSample: 0, endSample: 64000 }] });
  let result = await request('/api/voiceprints/profiles');
  assert.equal(result.data.profiles[0].meetingTitle, meeting.title);
  assert.equal((await request('/api/voiceprints/profiles/sample', 'PATCH', { enabled: 'false' })).status, 400);
  assert.equal((await request('/api/voiceprints/profiles/sample', 'PATCH', { enabled: false })).data.profile.enabled, false);
  result = await request('/api/voiceprints/profiles');
  assert.equal(result.data.profiles.length, 1, 'disabled samples remain visible for recovery');
  assert.equal(result.data.profiles[0].available, false);
  assert.equal((await request('/api/voiceprints/profiles/sample', 'PATCH', { enabled: true })).data.profile.available, true);
});

test('participant membership changes recheck attribution while renames and unchanged links only refresh labels', async t => {
  const { workbench: { store }, request, refreshes } = await fixture(t);
  const meeting = store.createMeeting({ title: '身份核对' });
  const line = store.appendTranscript(meeting.id, { text: '我同意。', speakerId: 'one' });
  const a = store.createMember({ name: '孙总' }), b = store.createMember({ name: '李总' });
  const endpoint = `/api/meetings/${meeting.id}/participants/${line.participantId}`;
  for (const [patch, kind] of [
    [{ name: '孙总' }, 'labels'], [{ memberId: a.id }, 'attribution'],
    [{ memberId: a.id, name: '孙总' }, 'labels'], [{ memberId: b.id }, 'attribution'],
    [{ memberId: null }, 'attribution'], [{ name: '本场李老师' }, 'labels'],
  ]) {
    assert.equal((await request(endpoint, 'PATCH', patch)).status, 200);
    assert.deepEqual(refreshes.at(-1), { meetingId: meeting.id, sourceIds: [line.id], kind });
  }
  assert.equal(store.getMeeting(meeting.id).transcriptRevision, 1);
  assert.equal(store.allTranscript(meeting.id)[0].speakerId, 'one');
});

test('legacy speaker labels remain saved when AI refresh fails and removing a label also refreshes it', async t => {
  const { workbench, request, refreshes } = await fixture(t);
  const { store, ai } = workbench;
  const meeting = store.createMeeting({ title: '旧接口标记' });
  const first = store.appendTranscript(meeting.id, { text: '第一位发言。', speakerId: 'one' });
  const second = store.appendTranscript(meeting.id, { text: '另一位发言。', speakerId: 'two' });
  store.updateMeeting(meeting.id, { processedRevision: 2 });
  const originalRefresh = ai.refreshSpeakers;
  ai.refreshSpeakers = () => { throw new Error('模型暂不可用'); };
  const saved = await request(`/api/meetings/${meeting.id}`, 'PATCH', { speakerLabels: { one: '孙总', two: '李总' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.speakerLabels.one, '孙总');
  assert.equal(saved.data.refreshJob.status, 'error');
  assert.match(saved.data.refreshJob.error, /模型暂不可用/);
  assert.equal(store.getMeeting(meeting.id).processedRevision, 2);
  ai.refreshSpeakers = originalRefresh;
  assert.equal((await request(`/api/meetings/${meeting.id}`, 'PATCH', { speakerLabels: { one: '孙总' } })).status, 200);
  assert.deepEqual(refreshes.at(-1), { meetingId: meeting.id, sourceIds: [second.id], kind: 'labels' });
  const count = refreshes.length;
  await request(`/api/meetings/${meeting.id}`, 'PATCH', { speakerLabels: { one: '孙总' } });
  assert.equal(refreshes.length, count, 'unchanged labels do not create a refresh');
  assert.equal(store.allTranscript(meeting.id)[0].participantId, first.participantId);
});

test('legacy speaker-only correction keeps current discussion and original ASR grouping, including agent attribution', async t => {
  const { workbench: { store }, request, refreshes } = await fixture(t);
  const meeting = store.createMeeting({ title: '旧接口归属修正' });
  const first = store.appendTranscript(meeting.id, { text: '先做验证。', speakerId: 'one' });
  const second = store.appendTranscript(meeting.id, { text: '我还有补充。', speakerId: 'two' });
  store.mutateMeeting(meeting.id, current => {
    current.processedRevision = 2;
    current.topics = [{ id: 'topic', entries: [{ id: 'entry', text: '先做验证。', author: 'ai', stale: false, evidenceIds: [first.id] }] }];
  });
  const endpoint = `/api/meetings/${meeting.id}/transcript/${first.id}`;
  const response = await request(endpoint, 'PATCH', { text: first.text, speakerId: 'two', author: 'agent' });
  assert.equal(response.status, 200);
  assert.equal(response.data.id, first.id);
  assert.equal(response.data.participantId, second.participantId);
  assert.equal(response.data.participantSource, 'agent');
  assert.equal(response.data.speakerId, 'one', 'raw ASR cluster is retained as source data');
  assert.equal(response.data.origin, 'asr');
  assert.deepEqual(refreshes.at(-1), { meetingId: meeting.id, sourceIds: [first.id], kind: 'attribution' });
  let current = store.getMeeting(meeting.id);
  assert.equal(current.processedRevision, 2); assert.equal(current.transcriptRevision, 2);
  assert.equal(current.topics[0].entries[0].stale, false);
  assert.equal(current.topics[0].entries[0].identityReview, true);
  assert.equal(store.allTranscript(meeting.id)[1].participantId, second.participantId);
  const edit = await request(endpoint, 'PATCH', { text: '改为先做测试。', author: 'agent' });
  assert.equal(edit.status, 200); assert.equal(edit.data.origin, 'agent');
  current = store.getMeeting(meeting.id);
  assert.equal(current.processedRevision, 0);
  assert.equal(current.transcriptRevision, 3);
  assert.equal(current.topics[0].entries[0].stale, true);
});

test('legacy corrections isolate unknown utterances and reject ambiguous historical speaker IDs without writes', async t => {
  const { workbench: { store }, request, refreshes } = await fixture(t);
  const meeting = store.createMeeting({ title: '历史编号' });
  const a = store.createRecording(meeting.id), b = store.createRecording(meeting.id), c = store.createRecording(meeting.id);
  const first = store.appendTranscript(meeting.id, { text: 'A录音', speakerId: 'speaker-5', recordingId: a.id });
  store.appendTranscript(meeting.id, { text: 'B录音', speakerId: 'speaker-5', recordingId: b.id });
  const third = store.appendTranscript(meeting.id, { text: '待修正', speakerId: 'speaker-3', recordingId: c.id });
  const legacy = store.getMeeting(meeting.id); delete legacy.participants;
  store.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(legacy), meeting.id);
  const before = store.rawTranscript(meeting.id);
  const ambiguous = await request(`/api/meetings/${meeting.id}/transcript/${third.id}`, 'PATCH', { speakerId: 'speaker-5' });
  assert.equal(ambiguous.status, 409);
  assert.deepEqual(store.rawTranscript(meeting.id), before);
  assert.equal(refreshes.length, 0);
  const one = await request(`/api/meetings/${meeting.id}/transcript/${first.id}`, 'PATCH', { speakerId: 'unknown' });
  const two = await request(`/api/meetings/${meeting.id}/transcript/${third.id}`, 'PATCH', { speakerId: 'unknown' });
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.notEqual(one.data.participantId, two.data.participantId);
  assert.equal(one.data.participantSource, 'host');
});
