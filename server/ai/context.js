import { retrieve, terms } from './retrieval.js';
import { isUnassignedUtterance, participantFor, speakerName } from '../../shared/people.js';

const currentEntry = entry => entry.status !== 'superseded';
const sourceCost = line => line.text.length + 180;
const clarificationContext = item => item && ({
  explanation: item.explanation, evidenceIds: item.evidenceIds, stale: item.stale, author: item.author, manualFields: item.manualFields,
  distinctions: (item.distinctions || []).map(({ id, title, text, example, evidenceIds, stale, author, manualFields }) => ({ id, title, text, example, evidenceIds, stale, author, manualFields })),
});
const attentionContext = item => item && ({ needed: item.needed, reason: item.reason, evidenceIds: item.evidenceIds, stale: item.stale, author: item.author, manualFields: item.manualFields });

export function knownContext(meeting, sources) {
  const sourceIds = new Set(sources.map(line => line.id));
  const topics = (meeting.topics || []).filter(topic => !topic.mergedInto);
  const knownTopics = topics.map(({ id, parentId, title, summary, summaryEvidenceIds, sourceRevision, manualFields, stale }) => ({ id, parentId, title, summary, summaryEvidenceIds, sourceRevision, manualFields, stale }));
  const entries = topics.flatMap(topic => (topic.entries || []).filter(currentEntry).map(entry => ({ ...entry, topicId: topic.id })))
    .sort((a, b) => Number(b.evidenceIds?.some(id => sourceIds.has(id))) - Number(a.evidenceIds?.some(id => sourceIds.has(id))) || Number(Boolean(b.manualFields?.length)) - Number(Boolean(a.manualFields?.length)) || Number(b.type === 'decision' || b.type === 'action') - Number(a.type === 'decision' || a.type === 'action'));
  const knownEntries = [];
  let size = 0;
  for (const entry of entries) {
    const item = { id: entry.id, topicId: entry.topicId, type: entry.type, text: entry.text, status: entry.status, evidenceIds: entry.evidenceIds, participantIds: (entry.participantIds || []).filter(id => { const person = participantFor(id, meeting); return person && !isUnassignedUtterance(person); }), manualFields: entry.manualFields, author: entry.author, stale: entry.stale };
    const cost = JSON.stringify(item).length;
    if (size + cost > 18000) continue;
    knownEntries.push(item); size += cost;
  }
  const existingFollowups = (meeting.followups || []).filter(item => !item.mergedInto).slice(-80).map(({ id, topicId, kind, question, shortQuestion, discussionValue, rationale, impact, clarification, attention, priority, status, evidenceIds, resolution, sourceRevision, stale, pendingReview, manualFields }) => ({ id, topicId, kind, question, shortQuestion, discussionValue, rationale, impact, clarification: clarificationContext(clarification), attention: attentionContext(attention), priority: priority && { level: priority.level, reason: priority.reason, evidenceIds: priority.evidenceIds, stale: priority.stale, author: priority.author, manualFields: priority.manualFields }, status, evidenceIds, resolution, sourceRevision, stale, pendingReview, manualFields }));
  return { knownTopics, knownEntries, existingFollowups, participants: (meeting.participants || []).filter(person => !person.mergedInto && !isUnassignedUtterance(person)).map(person => ({ id: person.id, memberId: person.memberId || null, displayName: speakerName(person.id, meeting) })), focusFollowupId: meeting.focusFollowupId ?? null, omittedEntryCount: entries.length - knownEntries.length };
}

// Select whole utterances and nearby replies. A question's original citation alone
// is not enough to establish whether the discussion has since answered it.
function collector(chunk, allLines, maxChars) {
  const selected = new Map(chunk.map(line => [line.id, line]));
  const positions = new Map(allLines.map((line, index) => [line.id, index]));
  let size = 0;
  function add(line) {
    if (!line || selected.has(line.id)) return;
    const cost = sourceCost(line);
    if (size + cost > maxChars) return;
    selected.set(line.id, line); size += cost;
  }
  function around(id) {
    const index = positions.get(id);
    if (index === undefined) return;
    add(allLines[index]);
    // Include adjacent short acknowledgements even when ASR times are missing.
    for (let offset = 1; offset <= 2; offset++) { add(allLines[index + offset]); add(allLines[index - offset]); }
    const anchor = allLines[index];
    if (!(anchor.endMs > anchor.startMs)) return;
    for (let offset = 3; offset <= 24; offset++) {
      for (const next of [allLines[index + offset], allLines[index - offset]]) {
        if (next && Math.abs(next.startMs - anchor.startMs) <= 25000) add(next);
      }
    }
  }
  return { add, around, result: () => [...selected.values()].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0)) };
}

export function supplementEvidence(meeting, chunk, allLines, maxChars = 14000) {
  const collect = collector(chunk, allLines, maxChars);
  const chunkIds = new Set(chunk.map(line => line.id));
  const chunkTerms = new Set(terms(chunk.map(line => line.text).join(' ')));
  const followups = (meeting.followups || []).filter(item => !item.mergedInto && item.status !== 'ignored');
  const relevant = followups.filter(item => item.status === 'active' || item.stale || item.pendingReview)
    .sort((a, b) => Number(b.id === meeting.focusFollowupId) - Number(a.id === meeting.focusFollowupId)
      || Number(a.attention?.needed === false) - Number(b.attention?.needed === false)
      || terms(b.question).filter(term => chunkTerms.has(term)).length - terms(a.question).filter(term => chunkTerms.has(term)).length);
  const relatedTopics = (meeting.topics || []).filter(topic => !topic.mergedInto && (topic.entries || []).some(entry => entry.evidenceIds?.some(id => chunkIds.has(id))) || !topic.mergedInto && terms(topic.title).some(term => chunkTerms.has(term)));
  // Preserve existing conclusions before spending the remaining budget on search.
  for (const topic of relatedTopics) for (const id of topic.summaryEvidenceIds || []) collect.add(allLines.find(line => line.id === id));
  for (const topic of meeting.topics || []) for (const entry of topic.entries || []) {
    if (entry.type === 'decision' && currentEntry(entry)) for (const id of entry.evidenceIds || []) collect.add(allLines.find(line => line.id === id));
  }
  for (const item of relevant) for (const id of item.resolution?.evidenceIds || []) collect.add(allLines.find(line => line.id === id));
  // Fresh context joins adjacent batches without reopening unrelated old topics.
  if (chunk.length && meeting.processedLineCount > 0) collect.around(chunk[0].id);
  const matches = relevant.map(item => retrieve(meeting, allLines, item.question, null, 2200).reverse());
  // Spread retrieval across issues; one old question must not crowd out the rest.
  for (let index = 0; index < Math.max(0, ...matches.map(items => items.length)); index++) {
    for (const items of matches) collect.add(items[index]);
  }
  for (const items of matches) for (const line of items.slice(0, 3)) collect.around(line.id);
  for (const item of relevant) for (const id of item.evidenceIds || []) collect.around(id);
  for (const topic of relatedTopics) for (const entry of (topic.entries || []).filter(currentEntry)) for (const id of entry.evidenceIds || []) collect.add(allLines.find(line => line.id === id));
  return collect.result();
}

export function reviewEvidence(meeting, allLines, followups, maxChars = 24000) {
  if (allLines.reduce((size, line) => size + sourceCost(line), 0) <= maxChars) return allLines;
  const collect = collector([], allLines, maxChars);
  const matches = followups.map(item => retrieve(meeting, allLines, `${item.question} ${item.resolution?.text || ''}`, null, 5000));
  // Round-robin prevents the first unresolved question consuming the entire budget.
  for (let index = 0; index < Math.max(0, ...matches.map(items => items.length)); index++) {
    for (const items of matches) if (items[index]) collect.around(items[index].id);
  }
  for (const item of followups) for (const id of [...(item.resolution?.evidenceIds || []), ...(item.evidenceIds || [])]) collect.around(id);
  return collect.result();
}
