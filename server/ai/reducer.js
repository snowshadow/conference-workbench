import { randomUUID } from 'node:crypto';
import { evidenceFor, normalize, similarQuestion, sourceLines } from './retrieval.js';
import { attributedPeople, groundedPeopleText, markPeopleFields } from './people.js';
import { resolvePeopleText } from '../../shared/people.js';
import { isActiveFocus, nextFocusId } from '../../shared/discussion-view.js';

const ENTRY_TYPES = new Set(['viewpoint', 'question', 'decision', 'action']);
const STATUSES = new Set(['active', 'open', 'resolved', 'superseded']);
const CLARIFICATION_KINDS = new Set(['concept', 'assumption', 'criteria', 'other']);
const PRIORITY_LEVELS = new Set(['high', 'medium', 'low']);
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

function writeSummary(topic, summary, evidenceIds, sourceRevision, stale = false) {
  if (topic.summary !== summary && topic.summary) {
    topic.history ||= [];
    topic.history.push({ summary: topic.summary, evidenceIds: [...(topic.summaryEvidenceIds || [])], sourceRevision: topic.sourceRevision, changedAt: new Date().toISOString() });
  }
  topic.summary = summary;
  topic.summaryEvidenceIds = [...new Set(evidenceIds)];
  topic.sourceRevision = sourceRevision;
  topic.stale = stale;
}

function followupHistory(item) {
  const { history, ...previous } = item;
  item.history ||= [];
  item.history.push({ ...structuredClone(previous), changedAt: new Date().toISOString() });
}

function hasNewEvidence(evidence, previous, byId) {
  const known = new Set(previous.map(item => `${item.id}:${item.revision}:${normalize(item.quote)}`));
  const latest = Math.max(-1, ...previous.map(item => byId.get(item.id)?.startMs ?? -1));
  // A fresh model call is not fresh evidence. Reusing an earlier trigger cannot
  // overturn a later answer merely because it has a different quote.
  return evidence.some(item => !known.has(`${item.id}:${item.revision}:${normalize(item.quote)}`) && ((byId.get(item.id)?.startMs ?? -1) >= latest || previous.some(old => old.id === item.id && old.revision !== item.revision)));
}

const mergeEvidence = (...groups) => [...new Map(groups.flat().filter(Boolean).map(item => [`${item.id}:${item.revision}:${normalize(item.quote)}`, item])).values()];
const clarificationEvidence = item => mergeEvidence(item?.evidence || [], ...(item?.distinctions || []).map(part => part.evidence || []));
const followupEvidence = item => mergeEvidence(item.evidence || [], clarificationEvidence(item.clarification), item.attention?.evidence || []);
const evidenceIds = evidence => [...new Set(evidence.map(item => item.id))];
const human = item => item?.author && item.author !== 'ai';
const protectedClarification = item => item && (human(item) || item.manualFields?.length || item.distinctions?.some(part => human(part) || part.manualFields?.length));
const explanationMeaning = item => item && ({ explanation: item.explanation, distinctions: (item.distinctions || []).map(({ title, text, example }) => ({ title, text, example })) });
const REVIEW_METADATA = new Set(['sourceRevision', 'presentationSourceRevision', 'updatedAt', 'createdAt', 'pendingReview', 'stale', 'peopleFields', 'identityReview', 'identityReviewedAt', 'history', 'priority', 'retrospective']);
const substantiveValue = value => {
  if (Array.isArray(value)) return value.map(substantiveValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !REVIEW_METADATA.has(key)).map(([key, child]) => [key, substantiveValue(child)]));
};
const sameSubstance = (a, b) => JSON.stringify(substantiveValue(a)) === JSON.stringify(substantiveValue(b));

// Every explanation and comparison carries its own source support. One invalid
// card rejects the new explanation as a whole, leaving the previous one intact.
function groundedClarification(input, byId, sourceRevision, meeting, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const evidence = evidenceFor(input, byId);
  const explanation = presentationText(input.explanation, 4000);
  if (!evidence || !explanation || input.distinctions !== undefined && !Array.isArray(input.distinctions) || (input.distinctions?.length || 0) > 12) return null;
  const used = new Set();
  const distinctions = [];
  for (const [index, raw] of (input.distinctions || []).entries()) {
    const support = evidenceFor(raw, byId);
    const title = presentationText(raw?.title, 200), text = presentationText(raw?.text, 2400);
    const example = raw?.example === undefined ? '' : presentationText(raw.example, 1200);
    if (!support || !title || !text || raw.example !== undefined && !example) return null;
    const oldParts = previous?.distinctions || [];
    const old = oldParts.find(part => !used.has(part.id) && part.id === raw.id)
      || oldParts.find(part => !used.has(part.id) && normalize(part.title) === normalize(title))
      || (oldParts[index] && !used.has(oldParts[index].id) ? oldParts[index] : null);
    const id = old?.id || makeId('distinction');
    used.add(id);
    const part = { id, title: groundedPeopleText(title, support, byId, meeting), text: groundedPeopleText(text, support, byId, meeting), ...(example ? { example: groundedPeopleText(example, support, byId, meeting) } : {}), evidence: support, evidenceIds: evidenceIds(support), author: 'ai', sourceRevision, stale: false, ...(old?.history ? { history: structuredClone(old.history) } : {}) };
    markPeopleFields(part, ['title', 'text', 'example'], meeting);
    distinctions.push(part);
  }
  const result = { explanation: groundedPeopleText(explanation, evidence, byId, meeting), distinctions, evidence, evidenceIds: evidenceIds(mergeEvidence(evidence, ...distinctions.map(part => part.evidence))), author: 'ai', sourceRevision, stale: false, ...(previous?.history ? { history: structuredClone(previous.history) } : {}) };
  markPeopleFields(result, ['explanation'], meeting);
  return result;
}

// Priority is a reading suggestion, independent of the factual record. Reuse
// the followup's validated citations without rewriting its question or history.
function groundedPriority(input, evidence, byId, sourceRevision, meeting) {
  const reason = presentationText(input?.reason, 600);
  if (!input || !PRIORITY_LEVELS.has(input.level) || !reason) return null;
  const result = { level: input.level, reason: groundedPeopleText(reason, evidence, byId, meeting), evidence, evidenceIds: evidenceIds(evidence), sourceRevision, author: 'ai', stale: false };
  markPeopleFields(result, ['reason'], meeting);
  return result;
}

function groundedResolution(input, byId, sourceRevision, meeting) {
  const evidence = evidenceFor(input, byId);
  const outcome = input?.resolution?.outcome;
  const text = clean(groundedPeopleText(input?.resolution?.text, evidence, byId, meeting));
  if (!evidence || !RESOLUTION_OUTCOMES.has(outcome) || !text) return null;
  // A speaker explaining their own meaning does not establish shared agreement.
  // Use full utterances so a model cannot crop “尚未达成共识” into “达成共识”.
  const agreement = /(?:大家|双方|全体|我们)(?:已经|已|都)?(?:达成一致|达成共识|同意|认可|确认)|(?:已经|已)达成(?:一致|共识)|一致同意/;
  if (agreement.test(text)) {
    const supported = evidence.some(item => byId.get(item.id).text.split(/[。！？!?；;\n]/).some(clause => agreement.test(clause) && !/(?:尚未|还没|没有|并未|是否|能否|如果|假如|希望|争取|期待|不能|不代表|不意味着).{0,20}(?:达成|同意|认可|确认)|(?:只有|只是).{0,12}(?:个人|我自己)/.test(clause)));
    if (!supported) return null;
  }
  // Missing complete supports saved/legacy provider fixtures. New prompts always
  // specify it; a partial explanation remains an active question.
  const complete = input.resolution.complete === undefined ? true : input.resolution.complete;
  if (typeof complete !== 'boolean') return null;
  const result = { outcome, text, complete, evidenceIds: [...new Set(evidence.map(item => item.id))], evidence, author: 'ai', sourceRevision, updatedAt: new Date().toISOString(), stale: false, pendingReview: false };
  markPeopleFields(result, ['text'], meeting);
  return result;
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
export function reduceOrganization(meeting, payload, lines, { sourceRevision = meeting.transcriptRevision, followupLimit = 1, fresh = true, allowStructure = true, retrospective = false } = {}) {
  const next = structuredClone(meeting);
  next.topics ||= []; next.followups ||= [];
  const byId = new Map(sourceLines(meeting.id, lines).map(line => [line.id, line]));
  const aliases = new Map(next.topics.map(topic => [topic.id, topic.id]));
  const pendingParents = [];
  const validInputs = [];
  for (const input of allowStructure && Array.isArray(payload.topics) ? payload.topics.slice(0, 100) : []) {
    const entryInputs = Array.isArray(input.entries) ? input.entries.slice(0, 100) : [];
    const grounded = entryInputs.map(entry => ({ entry, evidence: evidenceFor(entry, byId) })).filter(item => item.evidence && clean(item.entry.text));
    const summaryEvidence = input.summaryEvidence === undefined ? grounded.flatMap(item => item.evidence) : evidenceFor({ evidence: input.summaryEvidence }, byId);
    const title = clean(groundedPeopleText(input.title, summaryEvidence || grounded.flatMap(item => item.evidence), byId, next), 120);
    if (!title) continue;
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
    markPeopleFields(topic, ['title'], next);
    const summary = clean(groundedPeopleText(input.summary, summaryEvidence, byId, next), 1500);
    if (summary && summaryEvidence?.length && !(topic.manualFields || []).includes('summary') && sourceRevision >= (topic.sourceRevision || 0)) {
      writeSummary(topic, summary, summaryEvidence.map(item => item.id), sourceRevision);
      markPeopleFields(topic, ['summary'], next);
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
      const text = clean(groundedPeopleText(input.text, evidence, byId, next));
      const allEntries = next.topics.flatMap(t => t.entries || []);
      let entry = allEntries.find(e => e.id === input.id);
      if (!entry) entry = topic.entries.find(e => e.type === type && normalize(e.text) === normalize(text));
      if (entry && (entry.author !== 'ai' || sourceRevision < (entry.sourceRevision || 0) || entry.status === 'superseded')) continue;
      if (entry && ['decision', 'action'].includes(entry.type) && type !== entry.type && !entry.manualFields?.includes('type')) continue;
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
      } else if (entry.text !== text || entry.type !== type || input.status && entry.status !== input.status) {
        entry.history ||= [];
        entry.history.push({ text: entry.text, type: entry.type, status: entry.status, evidenceIds: entry.evidenceIds, sourceRevision: entry.sourceRevision, changedAt: new Date().toISOString() });
      }
      const manual = (entry.manualFields || []).length > 0;
      keepManual(entry, 'text', text);
      markPeopleFields(entry, ['text'], next);
      keepManual(entry, 'type', type);
      if (!manual) {
        entry.evidenceIds = [...new Set(evidence.map(item => item.id))];
        entry.evidence = evidence;
        entry.sourceRevision = sourceRevision;
        entry.stale = false;
        entry.participantIds = attributedPeople(input, evidence, byId, next);
      }
      // A model cannot silently retract a host-confirmed conclusion.
      if (STATUSES.has(input.status) && input.status !== 'superseded') keepManual(entry, 'status', input.status);
      if (type === 'action') {
        const sourceText = evidence.map(item => byId.get(item.id).text).join(' ');
        for (const field of ['owner', 'due']) {
          const value = clean(groundedPeopleText(input[field], evidence, byId, next), 200);
          if (value && normalize(sourceText).includes(normalize(resolvePeopleText(value, next)))) { keepManual(entry, field, value); markPeopleFields(entry, [field], next); }
          else if (!manual) delete entry[field];
        }
      }
      if (input.speakerId && evidence.some(item => byId.get(item.id).speakerId === input.speakerId)) keepManual(entry, 'speakerId', input.speakerId);
      if (!manual) {
        for (const oldId of Array.isArray(input.supersedes) ? input.supersedes : []) {
          const old = allEntries.find(e => e.id === oldId && e.id !== entry.id);
          if (!old || old.author !== 'ai' || old.manualFields?.length || old.status === 'superseded' || sourceRevision < (old.sourceRevision || 0) || ['decision', 'action'].includes(old.type) && old.type !== entry.type) continue;
          old.history ||= [];
          old.history.push({ text: old.text, type: old.type, status: old.status, sourceRevision: old.sourceRevision, evidenceIds: old.evidenceIds, changedAt: new Date().toISOString(), replacedBy: entry.id });
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
    writeSummary(topic, current.map(entry=>entry.text).join('；').slice(0,1500), current.flatMap(entry=>entry.evidenceIds || []), sourceRevision, !current.length && (topic.entries || []).some(entry=>entry.stale));
  }
  const keep = new Set(Array.isArray(payload.keepFollowupIds) ? payload.keepFollowupIds : []);
  const resolve = new Map((Array.isArray(payload.resolvedFollowups) ? payload.resolvedFollowups : []).map(item => [item?.id, groundedResolution(item, byId, sourceRevision, next)]).filter(([, resolution]) => resolution));
  for (const followup of next.followups) {
    if (!['active', 'resolved'].includes(followup.status) || followup.mergedInto || followup.author && followup.author !== 'ai' || sourceRevision < (followup.sourceRevision || 0)) continue;
    if ((followup.resolution && followup.resolution.author !== 'ai') || followup.manualFields?.includes('resolution') || followup.manualFields?.includes('status')) continue;
    const resolution = resolve.get(followup.id);
    if (resolution) {
      const previous = followup.resolution;
      if (previous) {
        const newEvidence = hasNewEvidence(resolution.evidence, previous.evidence || [], byId);
        // A late result may be rechecked unchanged against the latest transcript.
        // Changing its meaning still requires fresh source evidence.
        if (!newEvidence && !((previous.stale || previous.pendingReview || followup.pendingReview) && previous.outcome === resolution.outcome && (previous.complete ?? true) === resolution.complete && normalize(previous.text) === normalize(resolution.text))) continue;
        if (newEvidence) {
          followup.history ||= [];
          followup.history.push({ status: followup.status, resolution: structuredClone(previous), updatedAt: previous.updatedAt, updatedBy: previous.author });
        }
      }
      followup.status = resolution.complete ? 'resolved' : 'active'; followup.resolution = { ...resolution, pendingReview: !fresh }; followup.resolvedEvidence = resolution.evidence; followup.sourceRevision = sourceRevision; followup.stale = false; followup.pendingReview = !fresh;
    } else if (followup.status === 'active' && keep.has(followup.id) && followupEvidence(followup).length && followupEvidence(followup).every(item => evidenceFor({ evidence: [item] }, byId))) { followup.sourceRevision = sourceRevision; followup.stale = false; followup.pendingReview = !fresh; }
  }
  let added = 0;
  const followupAliases = new Map(next.followups.map(item => [item.id, item.id]));
  for (const input of Array.isArray(payload.followups) ? payload.followups : []) {
    const evidence = evidenceFor(input, byId);
    const groundedText = (value, max) => clean(groundedPeopleText(value, evidence, byId, next), max);
    const question = groundedText(input.question, 500), rationale = groundedText(input.rationale, 800), impact = groundedText(input.impact, 800);
    if (!evidence) continue;
    const exact = next.followups.find(f => f.id === input.id);
    const existing = exact || next.followups.find(f => question && similarQuestion(f.question, question));
    const clarification = groundedClarification(input.clarification, byId, sourceRevision, next, existing?.clarification);
    if (input.clarification !== undefined && !clarification) continue;
    const retrospectiveResolution = retrospective && input.resolution ? groundedResolution({ resolution: input.resolution, evidence: input.resolution.evidence }, byId, sourceRevision, next) : null;
    if (retrospective && input.resolution && !retrospectiveResolution) continue;
    const incomingEvidence = mergeEvidence(evidence, clarificationEvidence(clarification), retrospectiveResolution?.evidence || []);
    const priority = groundedPriority(input.priority, evidence, byId, sourceRevision, next);
    // Dropping an overlong display summary is safer than cutting off a condition or option.
    const shortQuestion = presentationText(groundedPeopleText(input.shortQuestion, evidence, byId, next), 200), discussionValue = presentationText(groundedPeopleText(input.discussionValue, evidence, byId, next), 800);
    if (existing) {
      if (input.id) followupAliases.set(input.id, existing.id);
      // Similarity prevents duplicates; only an explicit stable ID authorizes
      // evolving the substance of an existing question.
      if (!exact || !(existing.status === 'active' || retrospective && existing.status === 'resolved') || existing.mergedInto || existing.author !== 'ai' || existing.manualFields?.some(key => ['status', 'resolution'].includes(key)) || sourceRevision < Math.max(existing.sourceRevision || 0, existing.clarification?.sourceRevision || 0, existing.attention?.sourceRevision || 0) || existing.resolution && existing.resolution.author !== 'ai') continue;
      // A fresh rank may reuse the same utterance; a stale job must not replace
      // a newer rank, and metadata alone cannot bring a retired issue back.
      const mayRank = priority && !existing.manualFields?.length && !human(existing.priority) && !existing.priority?.manualFields?.length && !protectedClarification(existing.clarification) && sourceRevision >= (existing.priority?.sourceRevision || 0);
      const updatePriority = () => { if (mayRank && (isActiveFocus(existing) || retrospective && existing.status === 'resolved' && existing.attention?.needed !== false && !existing.stale)) existing.priority = priority; };
      updatePriority();
      const original = meeting.followups?.find(item => item.id === existing.id) || existing;
      const previousEvidence = mergeEvidence(followupEvidence(original), original.resolution?.evidence || []);
      const newEvidence = hasNewEvidence(incomingEvidence, previousEvidence, byId);
      const substantive = question && rationale && impact;
      const changedMeaning = substantive && (question !== existing.question || rationale !== existing.rationale || impact !== existing.impact);
      // Presentation-only edits can reuse current evidence. A changed question
      // after a partial answer needs evidence beyond that answer.
      const cannotReword = !retrospective && changedMeaning && !newEvidence && (original.resolution
        || Math.max(-1, ...evidence.map(item => byId.get(item.id)?.startMs ?? -1)) < Math.max(-1, ...previousEvidence.map(item => byId.get(item.id)?.startMs ?? -1))
        || !evidenceFor(existing, byId));
      // Legacy questions may gain their first explanation without changing an
      // already recorded partial answer or accepting the model's rewritten ask.
      if (cannotReword && (existing.clarification || !clarification)) continue;
      const patch = {};
      const mayRevisit = retrospective && existing.attention?.needed === false && !existing.manualFields?.length && !human(existing.attention) && !existing.attention.manualFields?.length && !protectedClarification(existing.clarification);
      if (retrospective && (existing.attention?.needed !== false || mayRevisit)) {
        patch.retrospective = true;
        // An offline reading can correct an earlier AI interpretation of the
        // same speech. Manual answers and later source revisions were guarded above.
        if (retrospectiveResolution) {
          patch.resolution = retrospectiveResolution; patch.resolvedEvidence = retrospectiveResolution.evidence;
          patch.status = retrospectiveResolution.complete ? 'resolved' : 'active';
        }
        if (mayRevisit) patch.attention = { needed: true, evidence: incomingEvidence, evidenceIds: evidenceIds(incomingEvidence), sourceRevision, author: 'ai', stale: false };
      }
      if (!cannotReword && substantive && (newEvidence || changedMeaning)) {
        for (const [key, value] of Object.entries({ question, rationale, impact })) if (!existing.manualFields?.includes(key)) patch[key] = value;
        if (CLARIFICATION_KINDS.has(input.kind) && !existing.manualFields?.includes('kind')) patch.kind = input.kind;
        if (Object.hasOwn(input, 'topicId') && (!input.topicId || aliases.has(input.topicId)) && !existing.manualFields?.includes('topicId')) patch.topicId = aliases.get(input.topicId) || null;
        if (!existing.manualFields?.some(key => ['question', 'rationale', 'impact', 'evidence'].includes(key))) {
          patch.evidence = evidence; patch.sourceRevision = sourceRevision;
          patch.stale = false; patch.pendingReview = !fresh;
        }
      }
      const mayExplain = !existing.manualFields?.includes('clarification') && !protectedClarification(existing.clarification);
      const explanationChanged = clarification && JSON.stringify(explanationMeaning(clarification)) !== JSON.stringify(explanationMeaning(existing.clarification));
      const mayReviseExplanation = retrospective || !existing.clarification || existing.clarification.stale || !explanationChanged || newEvidence;
      if (clarification && mayExplain && mayReviseExplanation) {
        patch.clarification = clarification;
        patch.sourceRevision = sourceRevision;
        if (!cannotReword && !existing.manualFields?.includes('evidence')) patch.evidence = evidence;
        patch.stale = false; patch.pendingReview = !fresh;
      } else if (patch.question && patch.question !== existing.question && existing.clarification && mayExplain) {
        patch.clarification = { ...existing.clarification, stale: true };
      }
      // Another analysis of the same utterance does not make a retired issue
      // newly relevant. Require an explicit explanation and a new/revised source.
      const renewed = incomingEvidence.some(item => !previousEvidence.some(old => old.id === item.id && old.revision === item.revision)) && newEvidence;
      if (existing.attention?.needed === false && clarification && mayExplain && renewed && !existing.manualFields?.length && !human(existing.attention) && !existing.attention.manualFields?.length) {
        patch.attention = { needed: true, evidence: incomingEvidence, evidenceIds: evidenceIds(incomingEvidence), sourceRevision, author: 'ai', stale: false };
      }
      if (patch.evidence || patch.clarification || patch.attention) patch.evidenceIds = evidenceIds(followupEvidence({ ...existing, ...patch }));
      if (!cannotReword && shortQuestion && !existing.manualFields?.includes('shortQuestion')) patch.shortQuestion = shortQuestion;
      else if (patch.question && patch.question !== existing.question && !existing.manualFields?.includes('shortQuestion')) patch.shortQuestion = undefined;
      if (!cannotReword && discussionValue && !existing.manualFields?.includes('discussionValue')) patch.discussionValue = discussionValue;
      if (Object.keys(patch).some(key => JSON.stringify(patch[key]) !== JSON.stringify(existing[key]))) {
        if (!sameSubstance(existing, { ...existing, ...patch })) followupHistory(existing);
        Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
        markPeopleFields(existing, Object.keys(patch), next);
        if (patch.shortQuestion || patch.discussionValue) existing.presentationSourceRevision = sourceRevision;
      }
      updatePriority();
      continue;
    }
    if (added >= followupLimit || !question || !rationale || !impact || input.affectsDecision === false || !CLARIFICATION_KINDS.has(input.kind)) continue;
    const topicId = aliases.get(input.topicId) || null;
    if (input.topicId && !topicId) continue;
    const id = makeId('followup');
    if (input.id) followupAliases.set(input.id, id);
    next.followups.push({ id, topicId, kind: input.kind, question, rationale, impact, ...(shortQuestion ? { shortQuestion } : {}), ...(discussionValue ? { discussionValue } : {}), ...((shortQuestion || discussionValue) ? { presentationSourceRevision: sourceRevision } : {}), ...(clarification ? { clarification } : {}), ...(priority ? { priority } : {}), evidenceIds: evidenceIds(incomingEvidence), evidence, status: retrospectiveResolution?.complete ? 'resolved' : 'active', ...(retrospective ? { retrospective: true } : {}), ...(retrospectiveResolution ? { resolution: retrospectiveResolution, resolvedEvidence: retrospectiveResolution.evidence } : {}), sourceRevision, stale: false, pendingReview: !fresh, author: 'ai', createdAt: new Date().toISOString() });
    markPeopleFields(next.followups.at(-1), ['question', 'shortQuestion', 'rationale', 'impact', 'discussionValue'], next);
    added++;
  }
  const resolveAlias = id => {
    const seen = new Set();
    let item = next.followups.find(f => f.id === (followupAliases.get(id) || id));
    while (item?.mergedInto && !seen.has(item.id)) { seen.add(item.id); item = next.followups.find(f => f.id === item.mergedInto); }
    return item;
  };
  for (const merge of Array.isArray(payload.mergedFollowups) ? payload.mergedFollowups.slice(0, 30) : []) {
    const source = resolveAlias(merge.sourceId), target = resolveAlias(merge.targetId);
    if (!source || !target || source === target || [source, target].some(item => item.status !== 'active' || item.author !== 'ai' || item.manualFields?.length || item.resolution && item.resolution.author !== 'ai' || sourceRevision < (item.sourceRevision || 0))) continue;
    if (!evidenceFor(source, byId) || !evidenceFor(target, byId)) continue;
    const { history: sourceHistory, ...sourceSnapshot } = source;
    followupHistory(source); followupHistory(target);
    target.history.push({ ...structuredClone(sourceSnapshot), mergedFrom: source.id, changedAt: new Date().toISOString() });
    const evidence = [...followupEvidence(target), ...followupEvidence(source), ...(target.resolution?.evidence || []), ...(source.resolution?.evidence || [])]
      .flatMap(item => evidenceFor({ evidence: [item] }, byId) || []);
    target.evidence = evidence.filter((item, index) => evidence.findIndex(other => other.id === item.id && other.quote === item.quote && other.revision === item.revision) === index);
    target.evidenceIds = [...new Set(target.evidence.map(item => item.id))];
    target.mergedFrom = [...new Set([...(target.mergedFrom || []), source.id, ...(source.mergedFrom || [])])];
    target.sourceRevision = sourceRevision;
    source.status = 'merged'; source.mergedInto = target.id;
    source.sourceRevision = sourceRevision;
  }
  for (const input of Array.isArray(payload.retiredFollowups) ? payload.retiredFollowups.slice(0, 100) : []) {
    const item = next.followups.find(followup => followup.id === input?.id);
    if (!item || item.status !== 'active' || item.mergedInto || item.author !== 'ai' || item.manualFields?.length || human(item.resolution) || protectedClarification(item.clarification) || human(item.attention) || item.attention?.manualFields?.length || sourceRevision < Math.max(item.sourceRevision || 0, item.attention?.sourceRevision || 0)) continue;
    const evidence = evidenceFor(input, byId);
    const reason = presentationText(input.reason, 1600);
    if (!evidence || !reason) continue;
    const attention = { needed: false, reason: groundedPeopleText(reason, evidence, byId, next), evidence, evidenceIds: evidenceIds(evidence), sourceRevision, author: 'ai', stale: false };
    markPeopleFields(attention, ['reason'], next);
    if (JSON.stringify(item.attention) === JSON.stringify(attention)) continue;
    if (!sameSubstance(item.attention, attention)) followupHistory(item);
    item.attention = attention;
    item.evidenceIds = evidenceIds(followupEvidence(item));
    item.sourceRevision = sourceRevision;
    item.updatedAt = new Date().toISOString();
  }
  const chosen = Object.hasOwn(payload, 'focusFollowupId') ? payload.focusFollowupId : next.focusFollowupId;
  const focus = chosen ? resolveAlias(chosen) : null;
  if (sourceRevision >= (next.focusSourceRevision || 0)) {
    if (Object.hasOwn(payload, 'focusFollowupId') || next.focusFollowupId !== undefined) {
      next.focusFollowupId = (isActiveFocus(focus) || retrospective && focus?.retrospective && focus.status === 'resolved' && !focus.stale && focus.attention?.needed !== false) ? focus.id : focus?.attention?.needed === false && !focus.stale ? nextFocusId(next, focus.id) : null;
      next.focusSourceRevision = sourceRevision;
    }
  }
  return next;
}
