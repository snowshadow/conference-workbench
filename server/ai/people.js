import { isUnassignedUtterance, participantFor, peopleReferences, personReference } from '../../shared/people.js';

export function sourceParticipantId(line, meeting) {
  if (!line) return null;
  const identifiedId = person => person && !isUnassignedUtterance(person) ? person.id : null;
  if (line.participantId) return identifiedId(participantFor(line.participantId, meeting));
  const candidates = (meeting.participants || []).filter(person => person.sourceIds?.includes(line.id) || person.speakerIds?.includes(line.speakerId) && (person.legacyRecordingId === undefined || person.legacyRecordingId === (line.recordingId || null)));
  const ids = [...new Set(candidates.map(person => identifiedId(participantFor(person.id, meeting))).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

export function allowedPeople(evidence, byId, meeting) {
  return new Set((evidence || []).map(item => sourceParticipantId(byId.get(typeof item === 'string' ? item : item.id), meeting)).filter(Boolean));
}

function groundedParticipantId(id, allowed, meeting) {
  const person = participantFor(id, meeting);
  if (!person) return null;
  if (allowed.has(person.id)) return person.id;
  // The host may bind two recording groups to one member without merging them.
  // Retain the cited group ID while recognizing that verified identity link.
  return person.memberId ? [...allowed].find(candidate => participantFor(candidate, meeting)?.memberId === person.memberId) || null : null;
}

export function groundedPeopleText(text, evidence, byId, meeting) {
  if (typeof text !== 'string') return text;
  const allowed = allowedPeople(evidence, byId, meeting);
  return text.replace(/\[\[person:([\s\S]*?)(?:\]\]|$)/g, (_, id) => {
    const canonical = groundedParticipantId(id, allowed, meeting);
    return canonical ? personReference(canonical) : '某位参会者';
  });
}

export function attributedPeople(input, evidence, byId, meeting) {
  const allowed = allowedPeople(evidence, byId, meeting);
  // Citation authors include questions, objections and context. They are not all
  // authors of a summarized viewpoint: only explicit model attribution is used.
  const proposed = Array.isArray(input.participantIds) ? input.participantIds : [];
  const rawIds = [...(Array.isArray(input.speakerIds) ? input.speakerIds : []), ...(input.speakerId ? [input.speakerId] : [])];
  const ids = proposed.map(id => groundedParticipantId(id, allowed, meeting));
  for (const speakerId of rawIds) {
    const line = (evidence || []).map(item => byId.get(item.id)).find(line => line?.speakerId === speakerId);
    ids.push(sourceParticipantId(line, meeting));
  }
  return [...new Set(ids.filter(id => id && allowed.has(id)))];
}

// This is a review signal, not an attribution rule. A name mentioned in prose
// may be a quoted third person, so only the existing evidence-based review may
// turn it into a stable person reference; never replace names here.
export function hasUnstructuredPeopleName(text, meeting) {
  if (typeof text !== 'string' || !meeting) return false;
  const prose = text.replace(/\[\[person:[^\]\s]+\]\]/g, ' ');
  const names = new Set();
  for (const item of meeting.participants || []) {
    const person = participantFor(item.id, meeting);
    if (!person) continue;
    const name = person.name?.trim() || person.speakerIds?.map(id => meeting.speakerLabels?.[id]).find(value => typeof value === 'string' && value.trim())?.trim();
    if (name) names.add(name);
  }
  for (const name of names) {
    const characters = [...name];
    for (let index = prose.indexOf(name); index !== -1; index = prose.indexOf(name, index + name.length)) {
      const before = [...prose.slice(0, index)].at(-1) || '', after = [...prose.slice(index + name.length)][0] || '';
      // A one-character label needs explicit boundaries: 甲 is not 甲方.
      // Chinese full names can adjoin Chinese prose. Latin names must not
      // match inside another word (Ann / Planning), but may adjoin Chinese.
      if (characters.length === 1 && /[\p{L}\p{N}_]/u.test(before + after)) continue;
      if (/[^\p{Script=Han}]/u.test(characters[0]) && /[\p{L}\p{N}_]/u.test(before) && !/\p{Script=Han}/u.test(before)) continue;
      if (/[^\p{Script=Han}]/u.test(characters.at(-1)) && /[\p{L}\p{N}_]/u.test(after) && !/\p{Script=Han}/u.test(after)) continue;
      return true;
    }
  }
  return false;
}

export function markPeopleFields(item, fields, meeting) {
  item.peopleFields = { ...item.peopleFields };
  for (const field of fields) if (typeof item[field] === 'string' && !item.manualFields?.includes(field)) item.peopleFields[field] = hasUnstructuredPeopleName(item[field], meeting) ? 0 : 1;
}

const refs = item => [...new Set([...(item.evidenceIds || []), ...(item.evidence || []).map(source => source.id)])];
const human = item => item.author && item.author !== 'ai';

/** One record per generated field; changes can only be written back to that field. */
export function peopleReviewRecords(meeting, lines, sourceIds, kind = 'attribution') {
  const affected = new Set(sourceIds), byId = new Map(lines.map(line => [line.id, line]));
  const records = [];
  const add = (item, path, fields, evidenceIds, context = {}) => {
    if (!item || human(item)) return;
    const ids = [...new Set(evidenceIds)].filter(id => byId.has(id));
    if (!ids.some(id => affected.has(id))) return;
    for (const field of fields) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item.manualFields?.includes(field) || kind === 'labels' && item.peopleFields?.[field] === 1 && !hasUnstructuredPeopleName(item[field], meeting)) continue;
      records.push({ id: `${path.join('/')}/${field}`, path, field, text: item[field], evidenceIds: ids, ...context });
    }
  };
  for (const topic of meeting.topics || []) {
    if (topic.mergedInto) continue;
    const ids = topic.summaryEvidenceIds?.length ? topic.summaryEvidenceIds : (topic.entries || []).flatMap(refs);
    add(topic, ['topics', topic.id], ['title', 'summary'], ids);
    for (const entry of topic.entries || []) if (entry.status !== 'superseded') add(entry, ['topics', topic.id, 'entries', entry.id], ['text', 'owner'], refs(entry), { entryType: entry.type, participantIds: entry.participantIds || [] });
  }
  for (const item of meeting.followups || []) {
    if (item.mergedInto || item.status === 'ignored') continue;
    add(item, ['followups', item.id], ['question', 'shortQuestion', 'rationale', 'impact', 'discussionValue'], refs(item));
    add(item.resolution, ['followups', item.id, 'resolution'], ['text'], refs(item.resolution || {}));
    if (!human(item) && !item.manualFields?.includes('clarification') && item.clarification && !human(item.clarification)) {
      const explanation = item.clarification;
      add(explanation, ['followups', item.id, 'clarification'], ['explanation'], (explanation.evidence || []).map(source => source.id));
      if (!explanation.manualFields?.includes('distinctions')) for (const part of explanation.distinctions || []) {
        if (part.id) add(part, ['followups', item.id, 'clarification', 'distinctions', part.id], ['title', 'text', 'example'], refs(part));
      }
    }
    if (!human(item) && !item.manualFields?.includes('priority')) add(item.priority, ['followups', item.id, 'priority'], ['reason'], refs(item.priority || {}));
    if (!human(item) && !item.manualFields?.includes('attention')) add(item.attention, ['followups', item.id, 'attention'], ['reason'], refs(item.attention || {}));
  }
  for (const item of meeting.questions || []) add(item, ['questions', item.id], ['answer', 'inference'], refs(item), { question: item.question });
  for (const item of meeting.artifacts || []) {
    const ids = [...refs(item), ...[...(item.markdown || '').matchAll(/#transcript:([^\s)]+)/g)].map(match => match[1])];
    add(item, ['artifacts', item.id], ['markdown'], ids);
  }
  return records;
}

export function peopleRecordTarget(meeting, path) {
  let current = meeting;
  for (const part of path) current = Array.isArray(current) ? current.find(item => item.id === part) : current?.[part];
  return current;
}

export function validPeopleReferences(text, evidence, byId, meeting) {
  const allowed = allowedPeople(evidence, byId, meeting);
  if (text.replace(/\[\[person:([^\]\s]+)\]\]/g, '').includes('[[person:')) return false;
  return peopleReferences(text).every(id => groundedParticipantId(id, allowed, meeting));
}
