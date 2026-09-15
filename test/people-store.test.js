import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';

function setup(t) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-people-')));
  t.after(() => store.close());
  const meeting = store.createMeeting({ title: '参会者身份' });
  return { store, meeting };
}

test('transcript creates stable session participants while every unknown utterance stays independent', t => {
  const { store, meeting } = setup(t);
  const first = store.appendTranscript(meeting.id, { text: '第一句', speakerId: 'live-session-a-speaker-0' });
  const same = store.appendTranscript(meeting.id, { text: '接着说', speakerId: first.speakerId });
  const different = store.appendTranscript(meeting.id, { text: '下一连接', speakerId: 'live-session-b-speaker-0' });
  const unknown = store.appendTranscript(meeting.id, { text: '未分辨发言一', speakerId: 'unknown' });
  const anotherUnknown = store.appendTranscript(meeting.id, { text: '未分辨发言二', speakerId: 'unknown' });
  assert.equal(first.participantId, same.participantId);
  assert.notEqual(first.participantId, different.participantId);
  assert.notEqual(unknown.participantId, anotherUnknown.participantId);
  assert.equal(store.listParticipants(meeting.id).length, 4);
  assert.equal(store.listParticipants(meeting.id)[0].identitySource, 'unassigned');
  store.updateParticipant(meeting.id, unknown.participantId, { name: '孙总' });
  assert.equal(store.listParticipants(meeting.id).find(p => p.id === anotherUnknown.participantId).name, '');
  assert.equal(store.getMeeting(meeting.id).speakerLabels.unknown, undefined);
});

test('naming a participant preserves source data, current discussion and analysis progress', t => {
  const { store, meeting } = setup(t);
  const line = store.appendTranscript(meeting.id, { text: '我建议先验证', speakerId: 'live-a-speaker-1' });
  store.mutateMeeting(meeting.id, m => {
    m.processedRevision = 1;
    m.topics = [{ id: 't', entries: [{ id: 'e', text: '建议先验证', type: 'viewpoint', status: 'active', stale: false, evidenceIds: [line.id] }] }];
    m.questions = [{ id: 'a', answer: '先验证', stale: false, evidenceIds: [line.id] }];
  });
  const before = store.getMeeting(meeting.id), raw = store.rawTranscript(meeting.id);
  const updated = store.updateParticipant(meeting.id, line.participantId, { name: '孙总', memberId: null });
  assert.deepEqual(updated.affectedSourceIds, [line.id]);
  assert.equal(updated.meeting.speakerLabels[line.speakerId], '孙总');
  assert.equal(updated.meeting.identityRevision, before.identityRevision + 1);
  assert.equal(updated.meeting.contentRevision, before.contentRevision + 1);
  assert.equal(updated.meeting.processedRevision, 1);
  assert.deepEqual(updated.meeting.topics, before.topics);
  assert.deepEqual(updated.meeting.questions, before.questions);
  assert.deepEqual(store.rawTranscript(meeting.id), raw);
  const participant = store.listParticipants(meeting.id)[0];
  assert.equal(participant.identitySource, 'manual'); assert.equal(participant.needsConfirmation, false);
});

test('automatic recognition progress persists separately from analysis versions and respects a manual lock', t => {
  const { store, meeting } = setup(t);
  const line = store.appendTranscript(meeting.id, { text: '讨论工作的安排', speakerId: 'live-a-speaker-3' });
  const member = store.createMember({ name: '陈工' });
  const before = store.getMeeting(meeting.id);
  store.setParticipantRecognition(meeting.id, line.participantId, { status: 'running', attempts: 1, jobId: 'job-1' });
  const pending = store.getMeeting(meeting.id);
  assert.equal(pending.identityRevision, before.identityRevision);
  assert.equal(pending.contentRevision, before.contentRevision);
  assert.equal(pending.participants[0].recognition.jobId, 'job-1');
  const ignored = store.applyRecognizedParticipant(meeting.id, line.participantId, { id: 'p', scope: 'team', memberId: member.id }, { expectedJobId: 'other-job' });
  assert.equal(ignored.applied, false);
  store.updateParticipant(meeting.id, line.participantId, { name: '主持人确认的来宾' });
  const late = store.applyRecognizedParticipant(meeting.id, line.participantId, { id: 'p', scope: 'team', memberId: member.id }, { expectedJobId: 'job-1' });
  assert.equal(late.applied, false);
  store.setParticipantRecognition(meeting.id, line.participantId, { status: 'error', error: 'late worker' });
  assert.equal(store.listParticipants(meeting.id)[0].recognition.status, 'confirmed');
  assert.equal(store.listParticipants(meeting.id)[0].name, '主持人确认的来宾');
});

test('automatic names remain distinct from host confirmation and apply only to unassigned real clusters', t => {
  const { store, meeting } = setup(t);
  const line = store.appendTranscript(meeting.id, { text: '讨论工作的安排', speakerId: 'live-a-speaker-3' });
  const member = store.createMember({ name: '陈工' });
  const candidate = { id: 'profile', scope: 'team', memberId: member.id, score: 0.96 };
  const raw = store.rawTranscript(meeting.id);
  const result = store.applyRecognizedParticipant(meeting.id, line.participantId, candidate);
  assert.equal(result.applied, true);
  assert.equal(result.meeting.participants[0].identitySource, 'voiceprint');
  assert.equal(result.meeting.participants[0].recognition.status, 'matched');
  assert.deepEqual(store.rawTranscript(meeting.id), raw);
  store.updateMember(member.id, { name: '陈老师' });
  assert.equal(store.listParticipants(meeting.id)[0].name, '陈老师');
  assert.equal(store.listParticipants(meeting.id)[0].identitySource, 'voiceprint');
  const unknownLine = store.appendTranscript(meeting.id, { text: '临时没有分组', speakerId: 'unknown' });
  assert.equal(store.applyRecognizedParticipant(meeting.id, unknownLine.participantId, candidate).applied, false);
});

test('restart makes interrupted recognition readable without changing names or analysis revisions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-recognition-restart-'));
  let store = new Store(directory);
  const meeting = store.createMeeting({ title: '恢复测试' });
  const line = store.appendTranscript(meeting.id, { text: '尚未完成的识别', speakerId: 'live-speaker' });
  store.setParticipantRecognition(meeting.id, line.participantId, { status: 'running', jobId: 'voice-job', attempts: 1, triedSourceIds: [line.id] });
  const before = store.getMeeting(meeting.id);
  store.close(); store = new Store(directory); t.after(() => store.close());
  const after = store.getMeeting(meeting.id);
  assert.equal(after.participants[0].recognition.status, 'error');
  assert.match(after.participants[0].recognition.error, /重启/);
  assert.equal(after.participants[0].recognition.jobId, 'voice-job');
  assert.equal(after.participants[0].recognition.attempts, 1);
  assert.equal(after.participants[0].name, '');
  assert.equal(after.identityRevision, before.identityRevision);
  assert.equal(after.contentRevision, before.contentRevision);
});

test('late ASR clustering replaces provisional unknown groups but preserves a confirmed name', t => {
  const { store, meeting } = setup(t);
  const known = store.appendTranscript(meeting.id, { text: '先识别的一句', speakerId: 'live-a-speaker-1' });
  const provisional = store.appendTranscript(meeting.id, { text: '暂时没分组', speakerId: 'unknown' });
  const confirmed = store.appendTranscript(meeting.id, { text: '主持人已经核对', speakerId: 'unknown' });
  store.updateParticipant(meeting.id, confirmed.participantId, { name: '孙总' });
  const corrected = store.editTranscript(meeting.id, provisional.id, { speakerId: known.speakerId, origin: 'asr' });
  const protectedLine = store.editTranscript(meeting.id, confirmed.id, { speakerId: known.speakerId, origin: 'asr' });
  assert.equal(corrected.participantId, known.participantId);
  assert.notEqual(corrected.participantId, provisional.participantId);
  assert.equal(protectedLine.participantId, confirmed.participantId);
  assert.equal(store.listParticipants(meeting.id).find(person => person.id === protectedLine.participantId).name, '孙总');
  assert.equal(protectedLine.speakerId, known.speakerId, 'the original ASR cluster remains available');
});

test('member IDs are reused across meetings; global renames sync and detached guests stay local', t => {
  const { store, meeting } = setup(t), other = store.createMeeting({ title: '下一场会议' });
  const member = store.createMember({ name: '孙总' });
  const a = store.appendTranscript(meeting.id, { text: '本次意见', speakerId: 'a' });
  const b = store.appendTranscript(other.id, { text: '另一次意见', speakerId: 'b' });
  store.updateParticipant(meeting.id, a.participantId, { memberId: member.id });
  store.updateParticipant(other.id, b.participantId, { memberId: member.id });
  const before = [store.getMeeting(meeting.id), store.getMeeting(other.id)];
  store.updateMember(member.id, { name: '孙先生' });
  for (const [index, m] of [meeting, other].entries()) {
    assert.equal(store.listParticipants(m.id)[0].name, '孙先生');
    assert.equal(store.getMeeting(m.id).identityRevision, before[index].identityRevision + 1);
  }
  store.updateParticipant(other.id, b.participantId, { memberId: null, name: '本场来宾' });
  store.updateMember(member.id, { name: '孙老师' });
  assert.equal(store.listParticipants(meeting.id)[0].name, '孙老师');
  assert.equal(store.listParticipants(other.id)[0].name, '本场来宾');
  assert.equal(store.listMembers().length, 1);
  assert.throws(() => store.updateParticipant(meeting.id, a.participantId, { memberId: 'missing' }), /团队成员不存在/);
  assert.equal(store.listParticipants(meeting.id)[0].memberId, member.id, 'failed binding is transactional');
});

test('assigning one utterance keeps its raw cluster and protects attribution from delayed ASR', t => {
  const { store, meeting } = setup(t);
  const line = store.appendTranscript(meeting.id, { text: '原识别内容', speakerId: 'live-a-speaker-1' });
  const other = store.appendTranscript(meeting.id, { text: '同组另一句', speakerId: line.speakerId });
  const { participant } = store.createParticipant(meeting.id, { name: '李总' });
  const before = store.getMeeting(meeting.id);
  const result = store.assignTranscriptParticipant(meeting.id, line.id, participant.id);
  assert.deepEqual(result.affectedSourceIds, [line.id]);
  assert.equal(result.meeting.transcriptEditRevision, before.transcriptEditRevision + 1);
  assert.equal(result.meeting.transcriptRevision, before.transcriptRevision);
  let saved = store.allTranscript(meeting.id)[0];
  assert.equal(saved.participantId, participant.id); assert.equal(saved.speakerId, line.speakerId);
  assert.equal(saved.origin, 'asr'); assert.equal(saved.history[0].participantId, line.participantId);
  saved = store.editTranscript(meeting.id, line.id, { text: 'ASR补齐的内容', speakerId: 'live-a-speaker-2', origin: 'asr' });
  assert.equal(saved.participantId, participant.id); assert.equal(saved.text, 'ASR补齐的内容');
  assert.equal(store.allTranscript(meeting.id)[1].participantId, other.participantId);
});

test('merging guests changes identity references without hiding current AI content or merging other meetings', t => {
  const { store, meeting } = setup(t), other = store.createMeeting({ title: '独立会议' });
  const source = store.appendTranscript(meeting.id, { text: '同一人前半段', speakerId: 'live-a-speaker-1' });
  const target = store.appendTranscript(meeting.id, { text: '同一人后半段', speakerId: 'live-b-speaker-3' });
  const foreign = store.appendTranscript(other.id, { text: '其他人', speakerId: 'live-a-speaker-1' });
  store.updateParticipant(meeting.id, target.participantId, { name: '孙总' });
  store.mutateMeeting(meeting.id, m => {
    m.processedRevision = m.transcriptRevision;
    m.topics = [{ id: 't', summaryEvidenceIds: [source.id], entries: [{ id: 'e', text: '观点仍在', stale: false, evidenceIds: [source.id] }] }];
    m.followups = [{ id: 'f', evidenceIds: [source.id], resolution: { author: 'host', text: '记录仍在', stale: false, evidenceIds: [source.id] } }];
    m.questions = [{ id: 'q', answer: '回答仍在', stale: false, evidenceIds: [source.id] }];
  });
  const before = store.getMeeting(meeting.id);
  const result = store.mergeParticipants(meeting.id, source.participantId, target.participantId);
  assert.deepEqual(result.affectedSourceIds, [source.id]);
  assert.equal(store.allTranscript(meeting.id)[0].participantId, target.participantId);
  assert.equal(store.allTranscript(other.id)[0].participantId, foreign.participantId);
  assert.equal(store.listParticipants(meeting.id).length, 1);
  assert.equal(store.listParticipants(meeting.id)[0].identitySource, 'manual');
  assert.equal(result.meeting.topics[0].entries[0].stale, false);
  assert.equal(result.meeting.topics[0].entries[0].identityReview, true);
  assert.equal(result.meeting.followups[0].resolution.stale, false);
  assert.equal(result.meeting.questions[0].stale, false);
  assert.equal(result.meeting.processedRevision, before.processedRevision);
  assert.throws(() => store.mergeParticipants(meeting.id, target.participantId, foreign.participantId), /不属于本次会议/);
});

test('manually merged unknown utterances keep explicit attribution when late ASR clusters arrive', t => {
  const { store, meeting } = setup(t);
  const first = store.appendTranscript(meeting.id, { text: '没有分组的发言', speakerId: 'unknown' });
  const second = store.appendTranscript(meeting.id, { text: '另一句没有分组', speakerId: 'unknown' });
  store.updateParticipant(meeting.id, second.participantId, { name: '孙总' });
  store.mergeParticipants(meeting.id, first.participantId, second.participantId);
  const saved = store.rawTranscript(meeting.id)[0];
  assert.equal(saved.participantId, second.participantId);
  assert.equal(saved.participantSource, 'host');
  assert.equal(saved.speakerId, 'unknown');
  assert.equal(saved.history.at(-1).participantId, first.participantId);
  const late = store.editTranscript(meeting.id, first.id, { text: 'ASR补齐发言', speakerId: 'live-new-speaker-3', origin: 'asr' });
  assert.equal(late.participantId, second.participantId);
  assert.equal(late.participantSource, 'host');
  assert.equal(late.text, 'ASR补齐发言');
});

test('legacy projection keeps old names while isolating repeated ASR numbers by recording without writes', t => {
  const { store, meeting } = setup(t);
  const a = store.createRecording(meeting.id), b = store.createRecording(meeting.id);
  const first = store.appendTranscript(meeting.id, { text: '旧会前段', speakerId: 'speaker-5', recordingId: a.id });
  const second = store.appendTranscript(meeting.id, { text: '旧会后段', speakerId: 'speaker-5', recordingId: b.id });
  const legacy = store.getMeeting(meeting.id);
  delete legacy.participants; delete legacy.identityRevision;
  legacy.speakerLabels = { 'speaker-5': '孙总' };
  store.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(legacy), meeting.id);
  const bytes = store.db.prepare('SELECT data FROM meetings WHERE id=?').get(meeting.id).data;
  const projected = store.getMeeting(meeting.id), again = store.getMeeting(meeting.id);
  assert.deepEqual(projected.participants, again.participants);
  assert.equal(projected.participants.length, 2);
  assert.ok(projected.participants.every(p => p.name === '孙总' && p.legacyName === '孙总' && p.needsConfirmation && p.memberId === null && p.identitySource === 'unassigned'));
  assert.equal(projected.speakerLabels['speaker-5'], '孙总');
  const lines = store.allTranscript(meeting.id);
  assert.notEqual(lines[0].participantId, lines[1].participantId);
  assert.deepEqual(lines.map(line => line.id), [first.id, second.id]);
  assert.equal(store.db.prepare('SELECT data FROM meetings WHERE id=?').get(meeting.id).data, bytes);
  store.updateParticipant(meeting.id, lines[0].participantId, { name: '孙总' });
  assert.equal(store.listParticipants(meeting.id)[0].needsConfirmation, false);
  assert.equal(store.listParticipants(meeting.id)[1].needsConfirmation, true);
});
