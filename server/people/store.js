import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const unknown = speakerId => !speakerId || ['unknown', '未知'].includes(speakerId);
const knownName = (value, required = false) => {
  if (typeof value !== 'string' || value.trim().length > 100 || (required && !value.trim())) throw problem('请填写 1–100 字的姓名');
  return value.trim();
};
const stableId = (meetingId, key) => `participant_${createHash('sha256').update(`${meetingId}:${key}`).digest('hex').slice(0, 24)}`;

export function resolveParticipant(meeting, participantId) {
  const seen = new Set();
  let participant = (meeting.participants || []).find(item => item.id === participantId);
  while (participant?.mergedInto) {
    if (seen.has(participant.id)) return null;
    seen.add(participant.id);
    participant = meeting.participants.find(item => item.id === participant.mergedInto);
  }
  return participant || null;
}

export function participantForLine(meeting, line) {
  if (line.participantId) {
    const assigned = resolveParticipant(meeting, line.participantId);
    if (assigned) return assigned;
  }
  // A provisional unknown utterance may acquire a diarization cluster in a
  // later ASR result. Only a human-confirmed identity keeps that per-line link.
  const participant = (meeting.participants || []).find(item => item.sourceIds?.includes(line.id) &&
    (unknown(line.speakerId) || item.identitySource === 'manual')) ||
    (meeting.participants || []).find(item => !unknown(line.speakerId) && item.speakerIds?.includes(line.speakerId) &&
      (item.legacyRecordingId === undefined || item.legacyRecordingId === (line.recordingId || null)));
  return participant ? resolveParticipant(meeting, participant.id) : null;
}

export function ensureParticipant(meeting, line, { legacy = false, ambiguous = false } = {}) {
  const existing = participantForLine(meeting, line);
  if (existing) return existing;
  const unidentified = unknown(line.speakerId);
  const legacyScope = legacy && !unidentified;
  const key = unidentified ? `line:${line.id}` : `${legacyScope ? `recording:${line.recordingId || 'none'}:` : ''}speaker:${line.speakerId}`;
  const oldName = meeting.speakerLabels?.[line.speakerId] || (!unidentified && /[\u3400-\u9fff]/u.test(line.speakerId) ? line.speakerId : '');
  const participant = {
    id: stableId(meeting.id, key), name: oldName, memberId: null,
    speakerIds: unidentified ? [] : [line.speakerId],
    ...(unidentified ? { sourceIds: [line.id] } : {}),
    ...(legacyScope ? { legacyRecordingId: line.recordingId || null } : {}),
    ...(oldName && legacy ? { legacyName: oldName } : {}),
    identitySource: 'unassigned', needsConfirmation: Boolean(ambiguous),
  };
  (meeting.participants ||= []).push(participant);
  return participant;
}

// Old files are projected without a write-on-read migration. In particular, an
// old ASR number reused by two recordings does not become one confirmed person.
export function projectPeople(meeting, lines, members) {
  const legacy = !Array.isArray(meeting.participants);
  meeting.participants ||= [];
  meeting.identityRevision ||= 0;
  const scopes = new Map();
  if (legacy) for (const line of lines) {
    if (unknown(line.speakerId)) continue;
    if (!scopes.has(line.speakerId)) scopes.set(line.speakerId, new Set());
    scopes.get(line.speakerId).add(line.recordingId || null);
  }
  for (const line of lines) ensureParticipant(meeting, line, { legacy, ambiguous: (scopes.get(line.speakerId)?.size || 0) > 1 });
  for (const [speakerId, name] of Object.entries(meeting.speakerLabels || {})) {
    if (unknown(speakerId) || meeting.participants.some(item => item.speakerIds?.includes(speakerId))) continue;
    ensureParticipant(meeting, { speakerId, id: `label:${speakerId}` }, { legacy: false }).name = name;
  }
  const byMember = new Map(members.map(member => [member.id, member]));
  for (const participant of meeting.participants) {
    if (participant.memberId && byMember.has(participant.memberId)) participant.name = byMember.get(participant.memberId).name;
  }
  syncSpeakerLabels(meeting);
  return meeting;
}

export function syncSpeakerLabels(meeting) {
  const labels = {};
  const aliases = new Map();
  for (const participant of meeting.participants || []) {
    const canonical = resolveParticipant(meeting, participant.id);
    for (const speakerId of participant.speakerIds || []) {
      if (unknown(speakerId)) continue;
      if (!aliases.has(speakerId)) aliases.set(speakerId, new Set());
      aliases.get(speakerId).add(canonical?.name || '');
    }
  }
  for (const [speakerId, names] of aliases) if (names.size === 1 && [...names][0]) labels[speakerId] = [...names][0];
  meeting.speakerLabels = labels;
  return meeting;
}

export function listMembers(store) {
  return store.db.prepare('SELECT data FROM members ORDER BY rowid').all().map(row => JSON.parse(row.data));
}
export function getMember(store, memberId) {
  if (typeof memberId !== 'string' || !memberId) throw problem('团队成员标识无效');
  const row = store.db.prepare('SELECT data FROM members WHERE id=?').get(memberId);
  if (!row) throw problem('团队成员不存在', 404);
  return JSON.parse(row.data);
}
export function createMember(store, { name } = {}) {
  const member = { id: randomUUID(), name: knownName(name, true), createdAt: now(), updatedAt: now() };
  store.db.prepare('INSERT INTO members(id,data) VALUES(?,?)').run(member.id, JSON.stringify(member));
  return member;
}
function identityChanged(meeting) {
  meeting.identityRevision = (meeting.identityRevision || 0) + 1;
  meeting.contentRevision = (meeting.contentRevision || 0) + 1;
}
export function updateMember(store, memberId, { name } = {}) {
  return store.transaction(() => {
    const member = getMember(store, memberId), nextName = knownName(name, true);
    if (member.name === nextName) return member;
    member.name = nextName; member.updatedAt = now();
    store.db.prepare('UPDATE members SET data=? WHERE id=?').run(JSON.stringify(member), memberId);
    for (const meeting of store.listMeetings({ includeArchived: true })) {
      if (!(meeting.participants || []).some(item => item.memberId === memberId)) continue;
      for (const participant of meeting.participants) if (participant.memberId === memberId) participant.name = nextName;
      identityChanged(meeting); syncSpeakerLabels(meeting); store.persistMeeting(meeting);
    }
    return member;
  });
}

function findParticipant(meeting, participantId) {
  if (typeof participantId !== 'string' || !participantId) throw problem('参会者标识无效');
  const participant = resolveParticipant(meeting, participantId);
  if (!participant) throw problem('参会者不存在或不属于本次会议', 404);
  return participant;
}
function applyIdentity(store, participant, patch) {
  if (Object.hasOwn(patch, 'memberId')) {
    if (patch.memberId !== null && typeof patch.memberId !== 'string') throw problem('团队成员标识无效');
    participant.memberId = patch.memberId;
  }
  if (Object.hasOwn(patch, 'name')) participant.name = knownName(patch.name);
  if (participant.memberId) participant.name = getMember(store, participant.memberId).name;
  if (!participant.name?.trim()) throw problem('请填写姓名或选择团队成员');
  participant.identitySource = 'manual'; participant.needsConfirmation = false; participant.updatedAt = now();
  if (participant.recognition) participant.recognition = { ...participant.recognition, status: 'confirmed', candidates: [], candidate: null, error: null, message: '已人工确认', updatedAt: now() };
}
export function createParticipant(store, meetingId, patch = {}) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId);
    const participant = { id: `participant_${randomUUID()}`, name: '', memberId: null, speakerIds: [], sourceIds: [] };
    applyIdentity(store, participant, patch);
    meeting.participants.push(participant); identityChanged(meeting);
    const updated = store.persistMeeting(syncSpeakerLabels(meeting));
    return { meeting: updated, participant, affectedSourceIds: [] };
  });
}
export function updateParticipant(store, meetingId, participantId, patch = {}) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId), participant = findParticipant(meeting, participantId);
    const before = JSON.stringify(participant);
    if (!Object.hasOwn(patch, 'name') && !Object.hasOwn(patch, 'memberId')) throw problem('请提供姓名或团队成员');
    applyIdentity(store, participant, patch);
    const affectedSourceIds = store.rawTranscript(meetingId).filter(line => participantForLine(meeting, line)?.id === participant.id).map(line => line.id);
    if (JSON.stringify(participant) !== before) identityChanged(meeting);
    return { meeting: store.persistMeeting(syncSpeakerLabels(meeting)), affectedSourceIds };
  });
}

export function canRecognizeParticipant(participant) {
  return Boolean(participant && !participant.mergedInto && !participant.name?.trim() && !participant.memberId &&
    participant.identitySource !== 'manual' && participant.identitySource !== 'voiceprint' &&
    participant.speakerIds?.some(speakerId => !unknown(speakerId) && !/^unk$/i.test(speakerId)));
}

// Recognition progress is operational state. It must not invalidate an AI task
// just because another few seconds of audio are being compared in the background.
export function setParticipantRecognition(store, meetingId, participantId, patch = {}) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId);
    const participant = meeting.participants.find(item => item.id === participantId);
    if (!participant) throw problem('参会者不存在或不属于本次会议', 404);
    const refreshOnly = participant.identitySource === 'voiceprint' && Object.keys(patch).every(key => ['analysisStatus', 'analysisJobId', 'analysisError'].includes(key));
    if (!canRecognizeParticipant(participant) && !refreshOnly) return participant;
    const next = { ...(participant.recognition || {}), ...structuredClone(patch) };
    if (JSON.stringify(next) === JSON.stringify(participant.recognition)) return participant;
    participant.recognition = { ...next, updatedAt: now() };
    store.persistMeeting(meeting);
    return structuredClone(participant);
  });
}

// This is intentionally separate from manual naming: a delayed match must never
// claim that the host confirmed someone, or overwrite a correction made in flight.
export function applyRecognizedParticipant(store, meetingId, participantId, candidate, { recognition = {}, expectedJobId } = {}) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId);
    const participant = meeting.participants.find(item => item.id === participantId);
    if (!participant) throw problem('参会者不存在或不属于本次会议', 404);
    if (meeting.archived || !canRecognizeParticipant(participant) ||
      expectedJobId && participant.recognition?.jobId !== expectedJobId) return { meeting, affectedSourceIds: [], applied: false };
    // Guests remain suggestions until the host explicitly merges the groups.
    // A team member ID is a stable identity without that irreversible UI merge.
    if (candidate?.scope !== 'team' || !candidate.memberId) return { meeting, affectedSourceIds: [], applied: false };
    const member = getMember(store, candidate.memberId);
    if (!member.name?.trim() || member.archived || member.deleted) throw problem('团队成员不可用，请重新确认');
    const affectedSourceIds = store.rawTranscript(meetingId).filter(line => participantForLine(meeting, line)?.id === participant.id).map(line => line.id);
    participant.name = member.name; participant.memberId = member.id;
    participant.identitySource = 'voiceprint'; participant.needsConfirmation = false; participant.updatedAt = now();
    participant.recognition = { ...(participant.recognition || {}), ...structuredClone(recognition), status: 'matched', candidate: structuredClone(candidate), candidates: [], error: null, message: '已根据声音识别', updatedAt: now() };
    identityChanged(meeting); markIdentitySourcesForReview(meeting, affectedSourceIds);
    return { meeting: store.persistMeeting(syncSpeakerLabels(meeting)), affectedSourceIds, applied: true };
  });
}

export function markIdentitySourcesForReview(meeting, affectedSourceIds) {
  const affected = new Set(affectedSourceIds);
  if (!affected.size) return;
  const matches = ids => (ids || []).some(id => affected.has(id));
  for (const topic of meeting.topics || []) {
    for (const entry of topic.entries || []) if (matches(entry.evidenceIds)) { entry.identityReview = true; topic.identityReview = true; }
    if (matches(topic.summaryEvidenceIds)) topic.identityReview = true;
  }
  for (const item of meeting.followups || []) {
    if (matches(item.evidenceIds)) item.identityReview = true;
    if (item.resolution && matches(item.resolution.evidenceIds)) item.resolution.identityReview = true;
  }
  for (const answer of meeting.questions || []) if (matches(answer.evidenceIds)) answer.identityReview = true;
  for (const artifact of meeting.artifacts || []) if (artifact.author === 'ai') { artifact.stale = true; artifact.staleReason = 'identity_changed'; }
}

export function mergeParticipants(store, meetingId, sourceId, targetId) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId), source = findParticipant(meeting, sourceId), target = findParticipant(meeting, targetId);
    if (source.id === target.id) throw problem('请选择另一个参会者');
    const affectedLines = store.rawTranscript(meetingId).filter(line => participantForLine(meeting, line)?.id === source.id);
    const affectedSourceIds = affectedLines.map(line => line.id);
    for (const line of affectedLines) {
      line.history = [...(line.history || []), { text: line.text, speakerId: line.speakerId, participantId: source.id, revision: line.revision, editedAt: now() }];
      line.participantId = target.id; line.participantSource = 'host';
      line.revision++; line.editedAt = now();
      store.db.prepare('UPDATE transcript SET data=? WHERE id=?').run(JSON.stringify(line), line.id);
    }
    source.mergedInto = target.id; source.updatedAt = now();
    if (affectedSourceIds.length) meeting.transcriptEditRevision = (meeting.transcriptEditRevision || 0) + 1;
    identityChanged(meeting); markIdentitySourcesForReview(meeting, affectedSourceIds);
    return { meeting: store.persistMeeting(syncSpeakerLabels(meeting)), affectedSourceIds };
  });
}

export function assignTranscriptParticipant(store, meetingId, lineId, participantId, { author = 'host' } = {}) {
  return store.transaction(() => {
    const meeting = store.getMeeting(meetingId), participant = findParticipant(meeting, participantId);
    const row = store.db.prepare('SELECT data FROM transcript WHERE id=? AND meeting_id=?').get(lineId, meetingId);
    if (!row) throw problem('转录片段不存在', 404);
    const line = JSON.parse(row.data), previous = participantForLine(meeting, line);
    if (previous?.id === participant.id && line.participantSource === author) return { meeting, affectedSourceIds: [] };
    line.history = [...(line.history || []), { text: line.text, speakerId: line.speakerId, participantId: previous?.id, revision: line.revision, editedAt: now() }];
    line.participantId = participant.id; line.participantSource = author === 'agent' ? 'agent' : 'host';
    line.revision++; line.editedAt = now();
    store.db.prepare('UPDATE transcript SET data=? WHERE id=?').run(JSON.stringify(line), line.id);
    // Identity changes leave the utterance and its audio untouched. They have
    // their own revision and review signal, so existing viewpoints stay visible.
    meeting.transcriptEditRevision = (meeting.transcriptEditRevision || 0) + 1;
    identityChanged(meeting); markIdentitySourcesForReview(meeting, [line.id]);
    return { meeting: store.persistMeeting(meeting), affectedSourceIds: [line.id] };
  });
}

export function applyLegacySpeakerLabels(meeting, labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels) || Object.values(labels).some(value => typeof value !== 'string')) throw problem('说话人名称格式无效');
  const known = new Set((meeting.participants || []).flatMap(item => item.speakerIds || []));
  for (const speakerId of Object.keys(labels)) {
    if (unknown(speakerId)) continue;
    if (!known.has(speakerId)) ensureParticipant(meeting, { speakerId, id: `label:${speakerId}` });
  }
  for (const participant of meeting.participants || []) {
    if (participant.mergedInto || participant.memberId || !participant.speakerIds?.length) continue;
    const name = labels[participant.speakerIds[0]] || '';
    participant.name = knownName(name);
    if (name) { participant.identitySource = 'manual'; participant.needsConfirmation = false; }
  }
  syncSpeakerLabels(meeting);
}
