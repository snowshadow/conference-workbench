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
  const tokenized = lines.map(line => new Set(terms(`${line.text} ${typeof meeting.speakerLabels?.[line.speakerId] === 'string' ? meeting.speakerLabels[line.speakerId] : ''}`)));
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
    if (!line || quote.length < 2 || !normalize(line.text).includes(normalize(quote))) return null;
    result.push({ id: line.id, quote, revision: line.revision });
  }
  return result;
}

export function sourceView(lines, speakerLabels = {}) {
  return lines.map(({ id, text, speakerId, startMs, revision, origin }) => ({ id, text, origin, speakerId: speakerId || '未知', speakerLabel: typeof speakerLabels[speakerId] === 'string' ? speakerLabels[speakerId].slice(0, 100) : '未知', startMs, revision }));
}
