// Person references are data, not names embedded into generated prose. Resolving
// this exact wire format leaves ordinary names, source quotes and host text alone.
const PERSON = /\[\[person:([^\]\s]+)\]\]/g;
export const personReference = id => `[[person:${id}]]`;
export const peopleReferences = text => [...new Set([...String(text || '').matchAll(PERSON)].map(match => match[1]))];

export function isUnassignedUtterance(person) {
  // Match the people store's raw ASR unknown values. Per-utterance placeholders
  // keep sources separate internally; they do not establish different people.
  return Boolean(person && !person.name?.trim() && !person.memberId && person.identitySource !== 'manual' && !(person.speakerIds || []).some(id => id && !['unknown', '未知'].includes(id)));
}

export function participantFor(id, meeting) {
  const participants = meeting?.participants || [];
  let person = participants.find(item => item.id === id);
  const visited = new Set();
  while (person?.mergedInto && !visited.has(person.id)) {
    visited.add(person.id);
    person = participants.find(item => item.id === person.mergedInto);
  }
  return person && !person.mergedInto ? person : null;
}

export function speakerName(participantId, meeting) {
  const person = participantFor(participantId, meeting);
  if (!person || isUnassignedUtterance(person)) return '未知说话人';
  return person.name?.trim() || person.speakerIds?.map(id => meeting.speakerLabels?.[id]).find(name => typeof name === 'string' && name.trim()) || `说话人 ${(meeting.participants || []).findIndex(item => item.id === person.id) + 1}`;
}

export function resolvePeopleText(text, meeting) {
  return typeof text === 'string' ? text.replace(PERSON, (_, id) => speakerName(id, meeting)) : text;
}

const TEXT_FIELDS = new Set(['title', 'summary', 'text', 'question', 'shortQuestion', 'discussionValue', 'rationale', 'impact', 'explanation', 'example', 'reason', 'answer', 'inference', 'markdown', 'owner']);
const SKIP = new Set(['evidence', 'resolvedEvidence', 'coverage', 'sources', 'input', 'participants', 'speakerLabels', 'transcript']);

/** Presentation-only clone, also suitable for AI job results. IDs stay intact. */
export function presentPeopleValue(value, meeting) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => presentPeopleValue(item, meeting));
  const copy = { ...value };
  const human = value.author && value.author !== 'ai';
  for (const [key, child] of Object.entries(value)) {
    if (SKIP.has(key) || human && key === 'history' || key === 'question' && Object.hasOwn(value, 'answer')) continue;
    if (TEXT_FIELDS.has(key) && typeof child === 'string') {
      if (!human && !value.manualFields?.includes(key)) copy[key] = resolvePeopleText(child, meeting);
    } else if (child && typeof child === 'object' && !value.manualFields?.includes(key) && !(human && ['clarification', 'attention', 'distinctions', 'priority'].includes(key))) copy[key] = presentPeopleValue(child, meeting);
  }
  return copy;
}

export function presentMeetingPeople(meeting) {
  if (!meeting) return meeting;
  // Meeting title and goal are authored by the host, never model output.
  return { ...meeting, topics: presentPeopleValue(meeting.topics, meeting), followups: presentPeopleValue(meeting.followups, meeting), questions: presentPeopleValue(meeting.questions, meeting), artifacts: presentPeopleValue(meeting.artifacts, meeting) };
}
