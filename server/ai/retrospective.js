import { createHash } from 'node:crypto';
import { knownContext } from './context.js';
import { sourceLines, sourceView } from './retrieval.js';
import { reduceOrganization } from './reducer.js';
import { RETROSPECTIVE_SYSTEM, RETROSPECTIVE_TOPICS, RETROSPECTIVE_TOPICS_CONTRACT, RETROSPECTIVE_FOCUS, RETROSPECTIVE_FOCUS_CONTRACT, RETROSPECTIVE_PROMPT_VERSION } from './retrospective-prompts.js';

export const RETROSPECTIVE_CONTEXT_CHARS = 48000;
const invalid = message => Object.assign(new Error(message), { status: 502 });
const stale = () => Object.assign(new Error('会议内容已修正，本次结果未写入；请重新生成。'), { code: 'STALE_RESULT' });
const jsonSize = value => JSON.stringify(value).length;
const PEOPLE_TEXT_FIELDS = new Set(['title', 'summary', 'text', 'question', 'shortQuestion', 'discussionValue', 'rationale', 'impact', 'explanation', 'example', 'reason', 'owner']);

// Compact only identity/provenance metadata. Speech and quoted evidence remain
// verbatim; the reducer still sees original IDs and this meeting's full sources.
export function retrospectiveCodec(meeting, lines) {
  const originals = new Map(lines.map(line => [line.id, line]));
  const sources = new Map(lines.map((line, index) => [line.id, `s${index + 1}`]));
  const people = new Map(knownContext(meeting, []).participants.map((person, index) => [person.id, `p${index + 1}`]));
  const sourceBack = new Map([...sources].map(([a, b]) => [b, a]));
  const peopleBack = new Map([...people].map(([a, b]) => [b, a]));
  const convert = (value, decode, key = '') => {
    if (key === 'sourceSpan' && value) return { ...value, from: (decode ? sourceBack : sources).get(value.from) || value.from, to: (decode ? sourceBack : sources).get(value.to) || value.to };
    if (Array.isArray(value)) return value.map(item => {
      if (typeof item === 'string' && /^(sourceIds|evidenceIds|summaryEvidenceIds)$/.test(key)) return (decode ? sourceBack : sources).get(item) || item;
      if (typeof item === 'string' && key === 'participantIds') {
        const id = (decode ? peopleBack : people).get(item);
        if (decode && !id && !people.has(item)) throw invalid('复盘结果引用了未知的参会者，请重试。');
        return id || item;
      }
      if (/^(evidence|summaryEvidence)$/.test(key) && item && typeof item === 'object') {
        const id = (decode ? sourceBack : sources).get(item.id) || item.id;
        if (!decode) return { ...item, id };
        const original = originals.get(id);
        if (!original) throw invalid('复盘结果中的引用与会议原话不符，请重试。');
        // The model selects a source, while the application supplies its exact
        // text. Legacy quoted excerpts remain valid only when actually verbatim.
        const quote = Object.hasOwn(item, 'quote') ? item.quote : original.text;
        if (typeof quote !== 'string' || quote.trim().length < 2 || !original.text.includes(quote.trim())) throw invalid('复盘结果中的引用与会议原话不符，请重试。');
        return { ...item, id, quote };
      }
      return convert(item, decode, key);
    });
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, convert(item, decode, name)]));
    if (typeof value !== 'string' || key === 'quote') return value;
    if (key === 'participantId') return (decode ? peopleBack : people).get(value) || value;
    if (!PEOPLE_TEXT_FIELDS.has(key)) return value;
    // Some providers use the supplied p1 label directly in prose. Decode that
    // label into the normal marker so citation-based attribution still decides
    // whether this person may be named. Never rewrite raw quotes or data IDs.
    return value.replace(/\[\[person:([^\]]+)\]\]|\bp\d+\b/g, (match, markerId) => {
      if (!decode && !markerId) return match;
      const id = markerId || match;
      const converted = (decode ? peopleBack : people).get(id);
      if (decode && !converted && !people.has(id)) throw invalid('复盘结果引用了未知的参会者，请重试。');
      return `[[person:${converted || id}]]`;
    });
  };
  return {
    encode: value => convert(value, false), decode: value => convert(value, true),
    sources: sourceView(lines, meeting).map((line, index) => ({ id: sources.get(line.id), text: line.text, participantId: people.get(line.participantId) || null, startMs: line.startMs, endMs: lines[index].endMs, ...(line.origin !== 'asr' ? { origin: line.origin } : {}) })),
    participants: knownContext(meeting, []).participants.map(person => ({ ...person, id: people.get(person.id) })),
  };
}

// Count the complete wire JSON, including IDs, participants and prior context.
// A line is never truncated or omitted to make a prompt fit.
export function packRetrospective(items, makeData, maxChars = RETROSPECTIVE_CONTEXT_CHARS) {
  const groups = []; let group = [];
  for (const item of items) {
    if (jsonSize(makeData([...group, item])) > maxChars) {
      if (group.length) { groups.push(group); group = []; }
      if (jsonSize(makeData([item])) > maxChars) throw invalid('一段复盘材料超过模型整理窗口，请缩减已有整理内容后重试。');
    }
    group.push(item);
  }
  if (group.length) groups.push(group);
  return groups;
}

// Artifact saves and job status do not change an analysis input. Real source,
// identity, topic and host edits do. This also avoids rerunning analysis merely
// because saving minutes increments the meeting's general contentRevision.
function signature(meeting, lines) {
  return createHash('sha256').update(JSON.stringify({
    title: meeting.title, goal: meeting.goal, transcriptRevision: meeting.transcriptRevision,
    transcriptEditRevision: meeting.transcriptEditRevision, identityRevision: meeting.identityRevision,
    participants: (meeting.participants || []).map(({ id, name, memberId, mergedInto, identitySource, speakerIds, legacyRecordingId }) => ({ id, name, memberId, mergedInto, identitySource, speakerIds, legacyRecordingId })), speakerLabels: meeting.speakerLabels,
    topics: meeting.topics, followups: meeting.followups,
    lines: lines.map(({ id, text, revision, participantId, speakerId, startMs, endMs, origin }) => ({ id, text, revision, participantId, speakerId, startMs, endMs, origin })),
  })).digest('hex');
}

function priorContext(meeting, lines) {
  const known = knownContext(meeting, lines);
  return {
    knownTopics: known.knownTopics,
    knownEntries: known.knownEntries,
    omittedEntryCount: known.omittedEntryCount,
    existingFollowups: known.existingFollowups.map(item => ({ id: item.id, topicId: item.topicId, question: item.question, status: item.status, evidenceIds: item.evidenceIds, manualFields: item.manualFields, ...(item.resolution ? { resolution: { text: item.resolution.text, complete: item.resolution.complete, outcome: item.resolution.outcome, author: item.resolution.author, evidence: item.resolution.evidence } } : {}) })),
  };
}

export async function runRetrospective({ store, meetingId, execution, complete, force = false, focusOnly = false, maxChars = RETROSPECTIVE_CONTEXT_CHARS }) {
  let snapshot = store.getMeeting(meetingId);
  const lines = sourceLines(meetingId, store.allTranscript(meetingId));
  if (!lines.length) return { processedRevision: snapshot.processedRevision, skipped: 'no_transcript' };
  const codec = retrospectiveCodec(snapshot, lines);
  let expected = signature(snapshot, lines);
  const assertCurrent = () => {
    const current = store.getMeeting(meetingId);
    if (current.archived || signature(current, sourceLines(meetingId, store.allTranscript(meetingId))) !== expected) throw stale();
  };
  const saved = snapshot.retrospectiveAnalysis;
  const reusable = saved?.promptVersion === RETROSPECTIVE_PROMPT_VERSION && saved.signature === expected && saved.topicsCompleted;
  if (reusable && saved.focusCompleted && !force && !focusOnly) return { processedRevision: snapshot.processedRevision, skipped: 'retrospective_complete' };
  // Failed focus generation resumes its completed topics even for a force retry.
  const resumeTopics = reusable && (!force || !saved.focusCompleted);
  const coverage = { scope: 'whole_meeting', totalSources: lines.length, throughMs: lines.reduce((end, line) => Math.max(end, line.endMs || line.startMs || 0), 0) };
  const base = mode => ({ meetingId, title: snapshot.title, goal: snapshot.goal, sourceRevision: snapshot.transcriptRevision, mode, meetingStatus: snapshot.status, participants: codec.participants, ...codec.encode(priorContext(snapshot, lines)), coverage });
  const stage = async (phase, data, instructions, purpose = phase) => {
    if (jsonSize(data) > maxChars) throw invalid('全场复盘材料超过模型整理窗口，请重试。');
    assertCurrent();
    const timing = { phase, startedAt: new Date().toISOString(), status: 'running' };
    execution.stages ||= []; execution.stages.push(timing);
    store.updateJob(execution.jobId, { stages: execution.stages, progress: { phase, completedBatches: (data.batch?.index || 1) - 1, totalBatches: data.batch?.total || 1 } });
    try {
      const payload = await complete(instructions, data, { ...execution, system: RETROSPECTIVE_SYSTEM, promptVersion: RETROSPECTIVE_PROMPT_VERSION, validateResult: codec.decode }, purpose);
      assertCurrent();
      timing.status = 'done';
      return payload;
    } catch (error) { timing.status = 'error'; throw error; }
    finally {
      timing.endedAt = new Date().toISOString(); timing.durationMs = Date.parse(timing.endedAt) - Date.parse(timing.startedAt);
      store.updateJob(execution.jobId, { stages: execution.stages });
    }
  };
  const topicInstructions = `${RETROSPECTIVE_TOPICS}\n${RETROSPECTIVE_TOPICS_CONTRACT}`;
  let material = resumeTopics ? saved.material : null;

  // Each intermediate section retains its source span. All sections participate
  // at the next level; global judgments are never made from keyword retrieval.
  const compressSections = async sections => {
    let current = sections;
    for (let depth = 0; depth < 6; depth++) {
      const makeData = coveredSections => ({ ...base('retrospective_synthesis'), coveredSections: codec.encode(coveredSections), coverage: { ...coverage, material: 'section_summaries', complete: false }, batch: { index: 9999, total: 9999 } });
      if (jsonSize(makeData(current)) <= maxChars) return current;
      const groups = packRetrospective(current, makeData, maxChars);
      const next = [];
      for (let index = 0; index < groups.length; index++) {
        const data = { ...makeData(groups[index]), batch: { index: index + 1, total: groups.length } };
        const payload = await stage('retrospective_extract', data, topicInstructions, 'retrospective_synthesis');
        next.push({ sourceSpan: { from: groups[index][0].sourceSpan.from, to: groups[index].at(-1).sourceSpan.to, count: groups[index].reduce((sum, section) => sum + section.sourceSpan.count, 0) }, topics: payload.topics, followups: payload.followups });
      }
      if (jsonSize(next) >= jsonSize(current)) throw invalid('全场提要未能压缩到可综合的长度，已保存的讨论内容保持不变，请重试。');
      current = next;
    }
    throw invalid('全场提要仍过长，无法完成可靠的综合，请重试。');
  };

  if (!resumeTopics) {
    const direct = { ...base('retrospective_topics'), sources: codec.sources, coverage: { ...coverage, material: 'verbatim', complete: true } };
    let result;
    if (jsonSize(direct) <= maxChars) {
      material = { kind: 'verbatim' };
      result = await stage('retrospective_topics', direct, topicInstructions);
    } else {
      const makeData = sources => ({ ...base('retrospective_extract'), sources, coverage: { ...coverage, material: 'verbatim', complete: false }, batch: { index: 9999, total: 9999 } });
      const groups = packRetrospective(codec.sources, makeData, maxChars);
      const sections = [];
      for (let index = 0; index < groups.length; index++) {
        const data = { ...makeData(groups[index]), batch: { index: index + 1, total: groups.length } };
        const extracted = await stage('retrospective_extract', data, topicInstructions);
        sections.push({ sourceSpan: codec.decode({ sourceSpan: { from: groups[index][0].id, to: groups[index].at(-1).id, count: groups[index].length } }).sourceSpan, topics: extracted.topics, followups: extracted.followups });
      }
      const coveredSections = await compressSections(sections);
      material = { kind: 'section_summaries', coveredSections };
      result = await stage('retrospective_topics', { ...base('retrospective_synthesis'), coveredSections: codec.encode(coveredSections), coverage: { ...coverage, material: 'section_summaries', complete: true } }, topicInstructions, 'retrospective_synthesis');
    }
    assertCurrent();
    const draft = reduceOrganization(snapshot, { ...result, followups: [], resolvedFollowups: [], mergedFollowups: [], retiredFollowups: [] }, lines, { sourceRevision: snapshot.transcriptRevision, followupLimit: 0 });
    snapshot = store.mutateMeeting(meetingId, meeting => {
      if (JSON.stringify(meeting.topics) !== JSON.stringify(draft.topics) || JSON.stringify(meeting.followups) !== JSON.stringify(draft.followups)) for (const artifact of meeting.artifacts || []) { artifact.stale = true; artifact.staleReason = 'content_changed'; }
      meeting.topics = draft.topics;
      // Topic merges also relocate existing questions, including host records.
      meeting.followups = draft.followups;
      meeting.processedRevision = snapshot.transcriptRevision; meeting.processedLineCount = lines.length; meeting.processedThroughMs = coverage.throughMs;
      meeting.retrospectiveAnalysis = { promptVersion: RETROSPECTIVE_PROMPT_VERSION, sourceRevision: snapshot.transcriptRevision, identityRevision: snapshot.identityRevision || 0, contentRevision: meeting.contentRevision + 1, topicsCompleted: true, focusCompleted: false, material, signature: signature(meeting, lines) };
    });
    expected = signature(snapshot, lines);
  }

  // New topics add context. If that leaves insufficient room for raw sources,
  // extract all of them instead of quietly dropping the late meeting material.
  let focusData = material.kind === 'verbatim' ? { ...base('retrospective_focus'), sources: codec.sources, coverage: { ...coverage, material: 'verbatim', complete: true } }
    : { ...base('retrospective_focus'), coveredSections: codec.encode(material.coveredSections), coverage: { ...coverage, material: 'section_summaries', complete: true } };
  if (jsonSize(focusData) > maxChars) {
    let sections = material.coveredSections;
    if (!sections) {
      const makeData = sources => ({ ...base('retrospective_extract'), sources, coverage: { ...coverage, material: 'verbatim', complete: false }, batch: { index: 9999, total: 9999 } });
      const groups = packRetrospective(codec.sources, makeData, maxChars);
      sections = [];
      for (let index = 0; index < groups.length; index++) {
        const extracted = await stage('retrospective_extract', { ...makeData(groups[index]), batch: { index: index + 1, total: groups.length } }, topicInstructions);
        sections.push({ sourceSpan: codec.decode({ sourceSpan: { from: groups[index][0].id, to: groups[index].at(-1).id, count: groups[index].length } }).sourceSpan, topics: extracted.topics, followups: extracted.followups });
      }
    }
    const coveredSections = await compressSections(sections);
    focusData = { ...base('retrospective_focus'), coveredSections: codec.encode(coveredSections), coverage: { ...coverage, material: 'section_summaries', complete: true } };
    assertCurrent();
    snapshot = store.mutateMeeting(meetingId, meeting => {
      meeting.retrospectiveAnalysis = { ...meeting.retrospectiveAnalysis, material: { kind: 'section_summaries', coveredSections }, contentRevision: meeting.contentRevision + 1 };
    });
  }
  const payload = await stage('retrospective_focus', focusData, `${RETROSPECTIVE_FOCUS}\n${RETROSPECTIVE_FOCUS_CONTRACT}`);
  assertCurrent();
  const before = snapshot.followups.length;
  const reviewInput = structuredClone(snapshot);
  for (const item of reviewInput.followups) {
    const records = [item, item.resolution, item.clarification, item.attention, item.priority, ...(item.clarification?.distinctions || [])].filter(Boolean);
    if (item.retrospective && !records.some(record => record.manualFields?.length || record.author && record.author !== 'ai')) item.retrospective = false;
  }
  const draft = reduceOrganization(reviewInput, { ...payload, topics: [] }, lines, { sourceRevision: snapshot.transcriptRevision, followupLimit: 100, allowStructure: false, retrospective: true });
  snapshot = store.mutateMeeting(meetingId, meeting => {
    if (JSON.stringify(meeting.followups) !== JSON.stringify(draft.followups)) for (const artifact of meeting.artifacts || []) { artifact.stale = true; artifact.staleReason = 'content_changed'; }
    meeting.followups = draft.followups; meeting.focusFollowupId = draft.focusFollowupId; meeting.focusSourceRevision = draft.focusSourceRevision;
    meeting.retrospectiveAnalysis = { ...meeting.retrospectiveAnalysis, contentRevision: meeting.contentRevision + 1, focusCompleted: true, completedAt: new Date().toISOString(), signature: signature(meeting, lines) };
  });
  return { processedRevision: snapshot.processedRevision, addedFollowups: snapshot.followups.length - before, retrospective: true };
}
