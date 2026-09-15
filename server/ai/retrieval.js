import { isUnassignedUtterance, participantFor, speakerName } from '../../shared/people.js';
import { sourceParticipantId } from './people.js';

const SOURCE_ORIGINS = new Set(['asr', 'host', 'agent']);

export function sourceLines(meetingId, lines) {
  return lines.filter(line => line.meetingId === meetingId && SOURCE_ORIGINS.has(line.origin) && typeof line.text === 'string' && line.text.trim() && !line.generated);
}

export function normalize(text = '') {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function terms(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const result = [];
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) result.push(word.slice(i, i + 2));
      if (word.length === 1) result.push(word);
    } else result.push(word);
  }
  return [...new Set(result)];
}

export function similarQuestion(a, b) {
  if (normalize(a) === normalize(b)) return true;
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  const intersection = [...x].filter(term => y.has(term)).length;
  return x.size && y.size && (2 * intersection) / (x.size + y.size) >= 0.68;
}

export function topicEvidence(meeting, topicId) {
  const selected = new Set([topicId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const topic of meeting.topics || []) {
      if (selected.has(topic.parentId) && !selected.has(topic.id)) { selected.add(topic.id); changed = true; }
    }
  }
  return new Set([
    ...(meeting.topics || []).filter(t => selected.has(t.id) && !t.mergedInto).flatMap(t => (t.entries || []).flatMap(e => e.evidenceIds || [])),
    ...(meeting.followups || []).filter(item => selected.has(item.topicId)).flatMap(item => [...(item.evidenceIds || []), ...(item.resolution?.evidenceIds || [])]),
  ]);
}

// Question answering must inspect the requested scope, including statements that
// use different words for the same issue. Lexical retrieval remains useful for
// live organization, but cannot establish coverage of a whole-meeting question.
export function answerScope(meeting, allLines, topicId) {
  const sources = sourceLines(meeting.id, allLines);
  if (!topicId) return { meeting, sources };
  const topics = new Set([topicId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const topic of meeting.topics || []) if (!topic.mergedInto && topics.has(topic.parentId) && !topics.has(topic.id)) {
      topics.add(topic.id); changed = true;
    }
  }
  const scopedMeeting = { ...meeting, topics: (meeting.topics || []).filter(topic => topics.has(topic.id) && !topic.mergedInto), followups: (meeting.followups || []).filter(item => topics.has(item.topicId) && !item.mergedInto) };
  const ids = topicEvidence(scopedMeeting, topicId);
  for (const topic of scopedMeeting.topics) for (const id of topic.summaryEvidenceIds || []) ids.add(id);
  return { meeting: scopedMeeting, sources: sources.filter(line => ids.has(line.id)) };
}

export const ANSWER_BATCH_CHARS = 36000;
export const ANSWER_CONTEXT_CHARS = 64000;
const answerSourceCost = (line, speakerLabels) => JSON.stringify(sourceView([line], speakerLabels)).length;

export function answerBatches(sources, maxChars = ANSWER_BATCH_CHARS, speakerLabels = {}) {
  const batches = [];
  let batch = [], size = 0;
  for (const line of sources) {
    const cost = answerSourceCost(line, speakerLabels);
    if (batch.length && size + cost > maxChars) { batches.push(batch); batch = []; size = 0; }
    batch.push(line); size += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Spread a bounded synthesis window across batches so early or recent sections
// cannot consume it before evidence from the rest of the meeting is considered.
export function answerCandidates(batches, selections, maxChars = ANSWER_CONTEXT_CHARS, speakerLabels = {}) {
  const candidates = selections.map((ids, index) => ids.map(id => batches[index].find(line => line.id === id)).filter(Boolean));
  const selected = new Map();
  let size = 0;
  for (let rank = 0; rank < Math.max(0, ...candidates.map(lines => lines.length)); rank++) {
    for (const lines of candidates) {
      const line = lines[rank];
      if (!line || selected.has(line.id) || size + answerSourceCost(line, speakerLabels) > maxChars) continue;
      selected.set(line.id, line); size += answerSourceCost(line, speakerLabels);
    }
  }
  return batches.flat().filter(line => selected.has(line.id));
}

/** Bounded lexical retrieval includes Chinese bigrams and ranks the full transcript, not just its tail. */
export function retrieve(meeting, allLines, question, topicId, maxChars = 16000) {
  const sources = sourceLines(meeting.id, allLines);
  const scopedIds = topicId ? topicEvidence(meeting, topicId) : null;
  const lines = scopedIds ? sources.filter(line => scopedIds.has(line.id)) : sources;
  const query = terms(question);
  // Clarification records are search pointers. They never enter the source set.
  const requestedKinds = new Set([
    /概念|定义|含义|口径|边界/.test(question) ? 'concept' : '',
    /假设|前提|验证/.test(question) ? 'assumption' : '',
    /标准|取舍|优先|分歧/.test(question) ? 'criteria' : '',
  ].filter(Boolean));
  const clarificationIds = new Set((meeting.followups || []).filter(item => item.status !== 'ignored' && (!topicId || scopedIds.has(item.evidenceIds?.[0])) && (requestedKinds.has(item.kind) || query.some(term => terms(`${item.question} ${item.impact || ''} ${item.resolution?.text || ''}`).includes(term)))).flatMap(item => [...(item.evidenceIds || []), ...(item.resolution?.evidenceIds || [])]));
  const tokenized = lines.map(line => new Set(terms(`${line.text} ${speakerName(sourceParticipantId(line, meeting), meeting)} ${typeof meeting.speakerLabels?.[line.speakerId] === 'string' ? meeting.speakerLabels[line.speakerId] : ''}`)));
  const frequencies = new Map(query.map(term => [term, tokenized.filter(words => words.has(term)).length]));
  const decisionIds = new Set((meeting.topics || []).flatMap(t => t.entries || []).filter(e => ['decision', 'action', 'question'].includes(e.type) && !e.stale).flatMap(e => e.evidenceIds || []));
  const ranked = lines.map((line, index) => ({
    line, index,
    score: query.reduce((total, term) => total + (tokenized[index].has(term) ? Math.log(1 + lines.length / (1 + frequencies.get(term))) : 0), 0) / Math.sqrt(1 + line.text.length / 400) + (decisionIds.has(line.id) ? 0.2 : 0) + (clarificationIds.has(line.id) ? 3 : 0),
  })).sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Map();
  let chars = 0;
  const add = index => {
    const line = lines[index];
    if (!line || selected.has(line.id)) return;
    const cost = Math.min(line.text.length, 8000) + 180;
    if (chars + cost > maxChars) return;
    selected.set(line.id, { ...line, text: line.text.slice(0, 8000) });
    chars += cost;
  };
  for (const item of ranked) { add(item.index); if (item.score > 0) { add(item.index - 1); add(item.index + 1); } }
  return [...selected.values()].sort((a, b) => a.startMs - b.startMs || sources.findIndex(x => x.id === a.id) - sources.findIndex(x => x.id === b.id));
}

export function evidenceFor(raw, linesById) {
  const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [];
  if (!evidence.length || evidence.length > 30) return null;
  const result = [];
  for (const item of evidence) {
    const line = linesById.get(item?.id);
    const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
    const normalizedQuote = normalize(quote);
    if (!line || quote.length < 2 || !normalizedQuote || !normalize(line.text).includes(normalizedQuote)) return null;
    result.push({ id: line.id, quote, revision: line.revision });
  }
  return result;
}

export function sourceView(lines, meetingOrLabels = {}) {
  const meeting = meetingOrLabels.participants || meetingOrLabels.speakerLabels ? meetingOrLabels : { speakerLabels: meetingOrLabels };
  return lines.map(line => {
    const { id, text, speakerId, startMs, revision, origin } = line;
    const participantId = sourceParticipantId(line, meeting);
    const legacyLabel = !isUnassignedUtterance(participantFor(line.participantId, meeting)) && typeof meeting.speakerLabels?.[speakerId] === 'string' ? meeting.speakerLabels[speakerId].slice(0, 100) : '';
    const displayName = participantId ? speakerName(participantId, meeting) : legacyLabel || '未知说话人';
    const memberId = participantId ? participantFor(participantId, meeting)?.memberId || null : null;
    return { id, text, origin, speakerId: speakerId || '未知', participantId, ...(memberId ? { memberId } : {}), displayName, speakerLabel: participantId ? participantFor(participantId, meeting)?.name?.trim() || '未知' : legacyLabel || '未知', startMs, revision };
  });
}
