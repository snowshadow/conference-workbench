import { randomUUID } from 'node:crypto';
import { evidenceFor, normalize, similarQuestion, sourceLines } from './retrieval.js';

const ENTRY_TYPES = new Set(['viewpoint', 'question', 'decision', 'action']);
const STATUSES = new Set(['active', 'open', 'resolved', 'superseded']);
const CLARIFICATION_KINDS = new Set(['concept', 'assumption', 'criteria', 'other']);
const RESOLUTION_OUTCOMES = new Set(['clarified', 'needs_verification', 'difference_remains']);
const clean = (value, max = 3000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const presentationText = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const makeId = prefix => `${prefix}_${randomUUID()}`;
function explicitDecision(text, quote) {
  // Check the original utterance, not only a model-selected positive fragment:
  // “还没决定采用 A” must never pass merely because the quote omits “还没”.
  const clauses = text.split(/[。！？!?;；\n]/).filter(Boolean);
  const quoted = normalize(quote);
  const relevant = clauses.filter(clause => normalize(clause).includes(quoted) || quoted.includes(normalize(clause)));
  const context = relevant.length ? relevant.join('。') : text;
  if (/[？?]/.test(text) || /(?:如果|假如|要是|假设|是否|能否|要不要|建议|提议|考虑|或许|可能|不确定|反对|尚未|还没|没有|并未|不能|不要|不应|不该|未曾|从未).{0,35}(?:决定|确定|定下来|拍板|改成|改为|采用|使用|选择|用|做)|(?:尚未|还没|没有|并未|不能|不要|不应|不该|未曾|从未).{0,8}达成|(?:if|should we|what if|consider|propose|haven'?t|didn'?t|not|never).{0,35}(?:decid|agree|use|go with)/i.test(context)) return false;
  return /(?:决定|定下来|就这么定|确定(?:采用|使用|选择|用|做)|最终(?:采用|使用|选择|选|用)|(?:就|我们)(?:按|采用|使用|选择|用).{0,30}(?:执行|推进|吧|了)|改(?:成|为)|拍板|we (?:decided|agree)|decision is|let'?s (?:use|go with))/i.test(context);
}

function keepManual(target, key, value) {
  if (!(target.manualFields || []).includes(key)) target[key] = value;
}

function groundedResolution(input, byId, sourceRevision) {
  const evidence = evidenceFor(input, byId);
  const outcome = input?.resolution?.outcome;
  const text = clean(input?.resolution?.text);
  if (!evidence || !RESOLUTION_OUTCOMES.has(outcome) || !text) return null;
  // A speaker explaining their own meaning does not establish shared agreement.
  // Use full utterances so a model cannot crop “尚未达成共识” into “达成共识”.
  const agreement = /(?:大家|双方|全体|我们)(?:已经|已|都)?(?:达成一致|达成共识|同意|认可|确认)|(?:已经|已)达成(?:一致|共识)|一致同意/;
  if (agreement.test(text)) {
    const supported = evidence.some(item => byId.get(item.id).text.split(/[。！？!?；;\n]/).some(clause => agreement.test(clause) && !/(?:尚未|还没|没有|并未|是否|能否|如果|假如|希望|争取|期待|不能|不代表|不意味着).{0,20}(?:达成|同意|认可|确认)|(?:只有|只是).{0,12}(?:个人|我自己)/.test(clause)));
    if (!supported) return null;
  }
  return { outcome, text, evidenceIds: [...new Set(evidence.map(item => item.id))], evidence, author: 'ai', sourceRevision, updatedAt: new Date().toISOString(), stale: false, pendingReview: false };
}

function validParent(topics, topicId, parentId) {
  if (!parentId) return true;
  const seen = new Set([topicId]);
  let cursor = topics.find(t => t.id === parentId && !t.mergedInto);
  if (!cursor) return false;
  while (cursor) {
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    cursor = topics.find(t => t.id === cursor.parentId);
  }
  return true;
}

export function validateTopicTree(topics) {
  return topics.filter(t => !t.mergedInto).every(topic => validParent(topics, topic.id, topic.parentId));
}

/** Apply only grounded operations. IDs from the model are aliases for new server-generated IDs. */
export function reduceOrganization(meeting, payload, lines, { sourceRevision = meeting.transcriptRevision, followupLimit = 1, fresh = true, allowStructure = true } = {}) {
  const next = structuredClone(meeting);
  next.topics ||= []; next.followups ||= [];
  const byId = new Map(sourceLines(meeting.id, lines).map(line => [line.id, line]));
  const aliases = new Map(next.topics.map(topic => [topic.id, topic.id]));
  const pendingParents = [];
  const validInputs = [];
  for (const input of allowStructure && Array.isArray(payload.topics) ? payload.topics.slice(0, 100) : []) {
    const title = clean(input.title, 120);
    if (!title) continue;
    const entryInputs = Array.isArray(input.entries) ? input.entries.slice(0, 100) : [];
    const grounded = entryInputs.map(entry => ({ entry, evidence: evidenceFor(entry, byId) })).filter(item => item.evidence && clean(item.entry.text));
    let topic = next.topics.find(t => t.id === input.id);
    if (topic?.mergedInto) topic = next.topics.find(t => t.id === topic.mergedInto);
    if (!topic) topic = next.topics.find(t => !t.mergedInto && normalize(t.title) === normalize(title));
    if (!topic && !grounded.length) continue;
    if (!topic) {
      topic = { id: makeId('topic'), parentId: null, title, summary: '', entries: [], manualFields: [], author: 'ai', history: [] };
      next.topics.push(topic);
    }
    if (input.id) aliases.set(input.id, topic.id);
    keepManual(topic, 'title', title);
    if (grounded.length && !(topic.manualFields || []).includes('summary')) {
      topic.summary = clean(input.summary, 1500) || grounded.map(x => clean(x.entry.text, 200)).join('；').slice(0, 1500);
      topic.stale = false;
      topic.sourceRevision = sourceRevision;
    }
    pendingParents.push({ topic, parentId: input.parentId });
    validInputs.push({ topic, grounded });
  }
  for (const { topic, parentId } of pendingParents) {
    if (parentId === undefined) continue;
    const resolved = parentId === null ? null : aliases.get(parentId);
    if ((parentId === null || resolved) && validParent(next.topics, topic.id, resolved)) keepManual(topic, 'parentId', resolved);
  }
  for (const { topic, grounded } of validInputs) {
    for (const { entry: input, evidence } of grounded) {
      let type = ENTRY_TYPES.has(input.type) ? input.type : 'viewpoint';
      if (type === 'decision' && !(input.explicitDecision === true && evidence.some(e => explicitDecision(byId.get(e.id).text, e.quote)))) type = 'viewpoint';
      const text = clean(input.text);
      const allEntries = next.topics.flatMap(t => t.entries || []);
      let entry = allEntries.find(e => e.id === input.id);
      if (!entry) entry = topic.entries.find(e => e.type === type && normalize(e.text) === normalize(text));
      if (entry && !(topic.entries || []).includes(entry)) {
        // Reparent only AI-owned entries. Explicit host splits and edits are preserved.
        if (entry.author !== 'ai' || (entry.manualFields || []).length) continue;
        for (const previous of next.topics) previous.entries = (previous.entries || []).filter(e => e.id !== entry.id);
        topic.entries.push(entry);
      }
      const newEntry = !entry;
      if (newEntry) {
        entry = { id: makeId('entry'), type, text, status: type === 'question' ? 'open' : 'active', evidenceIds: [], author: 'ai', manualFields: [], history: [] };
        topic.entries.push(entry);
      } else if (entry.text !== text || entry.type !== type) {
        entry.history ||= [];
        entry.history.push({ text: entry.text, type: entry.type, status: entry.status, evidenceIds: entry.evidenceIds, sourceRevision: entry.sourceRevision, changedAt: new Date().toISOString() });
      }
      const manual = (entry.manualFields || []).length > 0;
      keepManual(entry, 'text', text);
      keepManual(entry, 'type', type);
      if (!manual) {
        entry.evidenceIds = [...new Set(evidence.map(item => item.id))];
        entry.evidence = evidence;
        entry.sourceRevision = sourceRevision;
        entry.stale = false;
      }
      // A model cannot silently retract a host-confirmed conclusion.
      if (STATUSES.has(input.status) && !(type === 'decision' && input.status === 'superseded')) keepManual(entry, 'status', input.status);
      if (type === 'action') {
        const sourceText = evidence.map(item => byId.get(item.id).text).join(' ');
        for (const field of ['owner', 'due']) {
          const value = clean(input[field], 200);
          if (value && normalize(sourceText).includes(normalize(value))) keepManual(entry, field, value);
          else if (!manual) delete entry[field];
        }
      }
      if (input.speakerId && evidence.some(item => byId.get(item.id).speakerId === input.speakerId)) keepManual(entry, 'speakerId', input.speakerId);
      if (type === 'decision' && entry.type === 'decision' && !manual) {
        for (const oldId of Array.isArray(input.supersedes) ? input.supersedes : []) {
          const old = allEntries.find(e => e.id === oldId && e.id !== entry.id && e.type === 'decision');
          if (!old || (old.manualFields || []).includes('status')) continue;
          old.history ||= [];
          old.history.push({ status: old.status, sourceRevision: old.sourceRevision, evidenceIds: old.evidenceIds, changedAt: new Date().toISOString(), replacedBy: entry.id });
          old.status = 'superseded'; old.supersededBy = entry.id;
        }
      }
    }
  }
  for (const merge of allowStructure && Array.isArray(payload.merges) ? payload.merges.slice(0, 30) : []) {
    const source = next.topics.find(t => t.id === aliases.get(merge.sourceId));
    const target = next.topics.find(t => t.id === aliases.get(merge.targetId));
    if (!source || !target || source === target || source.mergedInto || target.mergedInto || source.manualFields?.length || target.manualFields?.length || (source.entries || []).some(e => e.author !== 'ai' || e.manualFields?.length) || next.topics.some(t => t.parentId === source.id && t.manualFields?.includes('parentId'))) continue;
    // A target inside source's subtree would create a cycle during reparenting.
    if (!validParent(next.topics, source.id, target.id)) continue;
    target.entries.push(...source.entries.filter(e => !target.entries.some(other => other.id === e.id)));
    source.entries = []; source.mergedInto = target.id;
    for (const child of next.topics.filter(t => t.parentId === source.id)) child.parentId = target.id;
    for (const followup of next.followups.filter(f => f.topicId === source.id)) followup.topicId = target.id;
    source.history ||= []; source.history.push({ mergedInto: target.id, sourceRevision });
  }
  // A model's raw summary must not contradict the host fields we preserved above.
  // Rebuild summaries of editorially corrected topics from their effective entries.
  if(allowStructure) for(const topic of next.topics) {
    if(topic.mergedInto || topic.manualFields?.includes('summary') || !(topic.entries || []).some(entry=>(entry.manualFields || []).some(field=>['text','type','status','owner','due','topicId'].includes(field)))) continue;
    const current=(topic.entries || []).filter(entry=>!entry.stale && entry.status!=='superseded');
    if(!current.length) {topic.summary='';topic.stale=(topic.entries || []).some(entry=>entry.stale);}
    else {topic.summary=current.map(entry=>entry.text).join('；').slice(0,1500);topic.stale=false;}
    topic.sourceRevision=sourceRevision;
  }
  const keep = new Set(Array.isArray(payload.keepFollowupIds) ? payload.keepFollowupIds : []);
  const resolve = new Map((Array.isArray(payload.resolvedFollowups) ? payload.resolvedFollowups : []).map(item => [item?.id, groundedResolution(item, byId, sourceRevision)]).filter(([, resolution]) => resolution));
  for (const followup of next.followups) {
    if (!['active', 'resolved'].includes(followup.status)) continue;
    if ((followup.resolution && followup.resolution.author !== 'ai') || followup.manualFields?.includes('resolution') || followup.manualFields?.includes('status')) continue;
    const resolution = resolve.get(followup.id);
    if (resolution) {
      const previous = followup.resolution;
      if (previous) {
        const oldEvidence = new Set((previous.evidence || []).map(item => `${item.id}:${item.revision}:${normalize(item.quote)}`));
        const newEvidence = resolution.evidence.some(item => !oldEvidence.has(`${item.id}:${item.revision}:${normalize(item.quote)}`));
        // A late result may be rechecked unchanged against the latest transcript.
        // Changing its meaning still requires fresh source evidence.
        if (!newEvidence && !((previous.stale || previous.pendingReview || followup.pendingReview) && previous.outcome === resolution.outcome && normalize(previous.text) === normalize(resolution.text))) continue;
        if (newEvidence) {
          followup.history ||= [];
          followup.history.push({ status: followup.status, resolution: structuredClone(previous), updatedAt: previous.updatedAt, updatedBy: previous.author });
        }
      }
      followup.status = 'resolved'; followup.resolution = { ...resolution, pendingReview: !fresh }; followup.resolvedEvidence = resolution.evidence; followup.sourceRevision = sourceRevision; followup.stale = false; followup.pendingReview = !fresh;
    } else if (followup.status === 'active' && keep.has(followup.id) && evidenceFor(followup, byId)) { followup.sourceRevision = sourceRevision; followup.stale = false; followup.pendingReview = !fresh; }
  }
  let added = 0;
  for (const input of Array.isArray(payload.followups) ? payload.followups : []) {
    const evidence = evidenceFor(input, byId);
    const question = clean(input.question, 500), rationale = clean(input.rationale, 800), impact = clean(input.impact, 800);
    if (!evidence) continue;
    const existing = next.followups.find(f => f.id === input.id || question && similarQuestion(f.question, question));
    // Dropping an overlong display summary is safer than cutting off a condition or option.
    const shortQuestion = presentationText(input.shortQuestion, 200), discussionValue = presentationText(input.discussionValue, 800);
    if (existing) {
      // Rephrase the reading surface without changing the original question or its sources.
      // Existing manually recorded questions remain exactly as the host left them.
      if (existing.status === 'active' && existing.author === 'ai' && !existing.resolution && !existing.manualFields?.includes('status') && evidence.every(item => existing.evidenceIds?.includes(item.id)) && evidenceFor(existing, byId)) {
        if (shortQuestion) keepManual(existing, 'shortQuestion', shortQuestion);
        if (discussionValue) keepManual(existing, 'discussionValue', discussionValue);
        if (shortQuestion && !existing.manualFields?.includes('shortQuestion') || discussionValue && !existing.manualFields?.includes('discussionValue')) existing.presentationSourceRevision = sourceRevision;
      }
      continue;
    }
    if (added >= followupLimit || !question || !rationale || !impact || input.affectsDecision === false || !CLARIFICATION_KINDS.has(input.kind)) continue;
    const topicId = aliases.get(input.topicId) || null;
    if (input.topicId && !topicId) continue;
    next.followups.push({ id: makeId('followup'), topicId, kind: input.kind, question, rationale, impact, ...(shortQuestion ? { shortQuestion } : {}), ...(discussionValue ? { discussionValue } : {}), ...((shortQuestion || discussionValue) ? { presentationSourceRevision: sourceRevision } : {}), evidenceIds: [...new Set(evidence.map(e => e.id))], evidence, status: 'active', sourceRevision, stale: false, pendingReview: !fresh, author: 'ai', createdAt: new Date().toISOString() });
    added++;
  }
  return next;
}
