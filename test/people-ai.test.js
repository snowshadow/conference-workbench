import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { checkPeopleReview } from '../server/ai/people-review.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { sourceView } from '../server/ai/retrieval.js';
import { knownContext } from '../server/ai/context.js';
import { allowedPeople, peopleReviewRecords, sourceParticipantId } from '../server/ai/people.js';
import { isUnassignedUtterance, participantFor, personReference, presentMeetingPeople, presentPeopleValue, resolvePeopleText, speakerName } from '../shared/people.js';

const response = output => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
function fixture(t, responder, options = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-people-ai-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const calls = [];
  const ai = createAIService({ store, speakerDebounceMs: 0, ...options, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push(data); return response(await responder(data, store, calls, request.signal));
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  return { store, ai, calls };
}
async function finish(store, job) {
  for (let i = 0; i < 1200; i++) {
    const current = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('identity refresh did not finish');
}
const line = (id, person, text) => ({ id, participantId: person, speakerId: `raw-${person}`, meetingId: 'm', origin: 'asr', revision: 1, text });
const baseMeeting = () => ({ id: 'm', transcriptRevision: 1, participants: [{ id: 'p1', name: '孙总', speakerIds: ['raw-p1'] }, { id: 'p2', name: '李明', speakerIds: ['raw-p2'] }], topics: [], followups: [], questions: [], artifacts: [] });
const evidence = source => ({ id: source.id, quote: source.text });

test('speaker review supports a whole document with 229 local references and unchanged text', () => {
  const meeting = baseMeeting();
  const sources = Array.from({ length: 229 }, (_, i) => line(`s${i}`, 'p1', i === 0 ? '好' : `第 ${i} 段会议原文。`));
  const byId = new Map(sources.map(source => [source.id, source]));
  const record = { id: 'artifacts/a/markdown', field: 'markdown', text: sources.map(source => `[[person:p1]] [原话](#transcript:${source.id})`).join('\n'), evidenceIds: sources.map(source => source.id) };
  const result = { unchanged: true, evidence: sources.map(({ id }) => ({ id })) };
  const checked = checkPeopleReview(record, result, byId, meeting);
  assert.equal(checked.issue, undefined);
  assert.equal(checked.update.text, record.text);
  assert.equal(result.evidence[0].quote, undefined, 'hydration must not rewrite the model response');
  const outside = line('foreign', 'p2', '同场但不在这个字段的引用范围。');
  byId.set(outside.id, outside);
  assert.equal(checkPeopleReview(record, { ...result, evidence: [{ id: outside.id }] }, byId, meeting).issue.code, 'unknown_source');
  assert.equal(checkPeopleReview(record, { ...result, text: '[[person:p2]]建议上线', unchanged: false }, byId, meeting).issue.code, 'unsupported_person');
});

test('local speaker edits preserve a long document and reject ambiguous anchors or changed links', () => {
  const meeting = baseMeeting(), source = line('s1', 'p1', '我建议验证。'), byId = new Map([[source.id, source]]);
  const prefix = '保留内容\n'.repeat(8000);
  const record = { id: 'a/markdown', field: 'markdown', text: `${prefix}有人建议验证 [原话](#transcript:s1)`, evidenceIds: ['s1'] };
  const output = { edits: [{ from: '有人建议验证', to: '[[person:p1]]建议验证' }], evidence: [{ id: 's1' }] };
  const checked = checkPeopleReview(record, output, byId, meeting);
  assert.equal(checked.issue, undefined);
  assert.equal(checked.update.text, `${prefix}[[person:p1]]建议验证 [原话](#transcript:s1)`);
  assert.equal(checkPeopleReview(record, { ...output, edits: [{ from: '保留内容', to: '替换内容' }] }, byId, meeting).issue.code, 'ambiguous_edit');
  assert.equal(checkPeopleReview(record, { ...output, edits: [{ from: '#transcript:s1', to: '#transcript:s2' }] }, byId, meeting).issue.code, 'changed_links');
  assert.equal(checkPeopleReview(record, { ...output, edits: [{ from: '有人', to: '[[person:p2]]' }] }, byId, meeting).issue.code, 'unsupported_person');
});

test('speaker review retries only invalid fields and publishes all updates after validation', async t => {
  let first, target, seeded, failedId, before;
  const { store, ai, calls } = fixture(t, (data, store, calls) => {
    const output = review(data, first, target);
    output.records.forEach(record => {
      record.evidence = record.evidence.map(({ id }) => ({ id }));
      record.edits = [{ from: data.records.find(input => input.id === record.id).text, to: record.text }];
      delete record.text;
    });
    if (calls.length === 1) {
      failedId = output.records[1].id;
      output.records[1].evidence = [{ id: 'invented-source' }];
    } else {
      assert.deepEqual(data.records.map(record => record.id), [failedId]);
      assert.equal(data.validationIssues[0].code, 'unknown_source');
      assert.deepEqual(store.getMeeting(seeded.meeting.id).topics, before.topics, 'no partial writes during repair');
      const running = store.listJobs(seeded.meeting.id)[0];
      assert.equal(running.progress.retrying, true);
      assert.ok(running.progress.completedRecords > 0);
    }
    return output;
  });
  seeded = seedRecords(store); ({ first, target } = seeded);
  store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, target);
  before = store.getMeeting(seeded.meeting.id);
  const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 2);
  assert.equal(job.modelCalls[0].validation.issues[0].recordId, failedId);
  assert.equal(job.modelCalls[1].validation.status, 'passed');
  assert.equal(job.progress.completedRecords, job.progress.totalRecords);
  assert.equal(job.progress.completedBatches, job.progress.totalBatches);
  assert.match(store.getMeeting(seeded.meeting.id).topics[0].entries[0].text, new RegExp(target));
});

test('unchanged speaker review replies preserve source-grounded entry attribution', async t => {
  const { store, ai } = fixture(t, data => ({ records: data.records.map(record => ({ id: record.id, unchanged: true })) }));
  const seeded = seedRecords(store);
  const before = store.getMeeting(seeded.meeting.id).topics[0].entries[0];
  const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]));
  assert.equal(job.status, 'done', job.error);
  const after = store.getMeeting(seeded.meeting.id).topics[0].entries[0];
  assert.equal(after.text, before.text);
  assert.deepEqual(after.participantIds, before.participantIds);
});

test('speaker format retries retain the reason and accept compact unchanged confirmations', async t => {
  const { store, ai } = fixture(t, (data, store, calls) => calls.length === 1
    ? { records: data.records.map(record => ({ id: record.id, text: record.text })) }
    : { records: data.records.map(record => ({ id: record.id, unchanged: true })) });
  const seeded = seedRecords(store);
  const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]));
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.modelCalls.length, 1);
  assert.equal(job.modelCalls[0].formatRetries, 1);
  assert.match(job.modelCalls[0].formatErrors[0], /发言人核对.*格式无效/);
  assert.equal(job.modelCalls[0].validation.status, 'passed');
});

test('presentation resolves exact stable references after rename/merge without rewriting names, quotes, IDs or host text', () => {
  const meeting = baseMeeting();
  const token = personReference('p1');
  meeting.topics = [{ id: 't', author: 'ai', title: `${token}的建议`, entries: [{ id: 'ai', author: 'ai', text: `${token}建议验证；孙总是原文称呼`, participantIds: ['p1'], evidence: [{ id: 's', quote: token }] }, { id: 'host', author: 'host', text: `人工保留 ${token} 孙总` }] }];
  meeting.questions = [{ id: 'q', author: 'ai', question: `怎样理解 ${token}？`, answer: `${token}建议验证` }];
  meeting.participants[0].name = '孙先生';
  const view = presentMeetingPeople(meeting);
  assert.equal(view.topics[0].title, '孙先生的建议');
  assert.equal(view.topics[0].entries[0].text, '孙先生建议验证；孙总是原文称呼');
  assert.equal(view.topics[0].entries[0].evidence[0].quote, token);
  assert.deepEqual(view.topics[0].entries[0].participantIds, ['p1']);
  assert.equal(view.topics[0].entries[1].text, `人工保留 ${token} 孙总`);
  assert.equal(view.questions[0].question, `怎样理解 ${token}？`);
  assert.equal(meeting.topics[0].title, `${token}的建议`, 'presentation must not mutate persistence');
  meeting.participants[0].mergedInto = 'p2';
  assert.equal(resolvePeopleText(token, meeting), '李明');
  assert.equal(speakerName('missing', meeting), '未知说话人');
  assert.equal(presentPeopleValue({ answer: token, evidence: [{ quote: token }], author: 'ai' }, meeting).answer, '李明');
  meeting.participants[1].mergedInto = 'p1';
  assert.equal(participantFor('p1', meeting), null, 'corrupt cycles cannot loop');
});

test('source views use per-line participant identities even when raw ASR numbers are reused', () => {
  const meeting = baseMeeting();
  meeting.participants[1].speakerIds = ['raw-p1'];
  const sources = [line('s1', 'p1', '我建议先验证。'), { ...line('s2', 'p2', '我建议直接上线。'), speakerId: 'raw-p1' }];
  assert.deepEqual(sourceView(sources, meeting).map(item => [item.participantId, item.displayName]), [['p1', '孙总'], ['p2', '李明']]);
  assert.equal(sourceView(sources, meeting)[0].text, sources[0].text);
  meeting.participants.forEach(person => { person.name = ''; });
  assert.deepEqual(sourceView(sources, meeting).map(item => item.displayName), ['说话人 1', '说话人 2']);
  assert.equal(meeting.participants[0].name, '', 'display fallback does not name a person');
});

test('unknown utterance placeholders stay unknown instead of suggesting hundreds of distinct speakers', () => {
  const meeting = baseMeeting();
  meeting.participants = [
    ...Array.from({ length: 285 }, (_, i) => ({ id: `unknown-${i}`, name: '', identitySource: 'unassigned', speakerIds: i % 2 ? [] : ['unknown', '未知', ''] })),
    { id: 'named', name: '孙总', identitySource: 'manual', speakerIds: [] },
    { id: 'cluster', name: '', speakerIds: ['speaker-1'] },
    { id: 'manual', name: '', identitySource: 'manual', speakerIds: [] },
    { id: 'member', name: '', memberId: 'member-1', speakerIds: [] },
  ];
  for (const person of meeting.participants.slice(0, 285)) {
    assert.equal(isUnassignedUtterance(person), true);
    assert.equal(speakerName(person.id, meeting), '未知说话人');
  }
  for (const person of meeting.participants.slice(285)) assert.equal(isUnassignedUtterance(person), false);
  assert.equal(speakerName('named', meeting), '孙总');
  assert.equal(speakerName('cluster', meeting), '说话人 287');
  assert.equal(speakerName('manual', meeting), '说话人 288');
  assert.equal(speakerName('member', meeting), '说话人 289');
  assert.equal(meeting.participants[0].name, '');
});

test('unknown utterances remain citable but do not expose placeholder identities to AI or authorize attribution', () => {
  const meeting = baseMeeting();
  meeting.participants = ['unknown-a', 'unknown-b'].map(id => ({ id, name: '', speakerIds: [], identitySource: 'unassigned' }));
  const sources = [line('s1', 'unknown-a', '我建议先验证。'), line('s2', 'unknown-b', '明天再确定上线时间。')].map(item => ({ ...item, speakerId: 'unknown' }));
  meeting.topics = [{ id: 'old', title: '已有记录', entries: [{ id: 'old-entry', text: '先验证', participantIds: ['unknown-a'], evidenceIds: ['s1'] }] }];
  const visibleSources = sourceView(sources, meeting);
  assert.deepEqual(visibleSources.map(item => [item.participantId, item.displayName]), [[null, '未知说话人'], [null, '未知说话人']]);
  assert.deepEqual(visibleSources.map(item => [item.id, item.text]), sources.map(item => [item.id, item.text]));
  assert.deepEqual(knownContext(meeting, sources).participants, []);
  assert.deepEqual(knownContext(meeting, sources).knownEntries[0].participantIds, []);
  assert.equal(allowedPeople(sources.map(evidence), new Map(sources.map(item => [item.id, item])), meeting).size, 0);
  const result = reduceOrganization(meeting, { topics: [{ id: 'new', title: '验证安排', entries: [{ text: '[[person:unknown-a]]建议先验证', participantIds: ['unknown-a'], evidence: [evidence(sources[0])] }] }], followups: [] }, sources);
  const entry = result.topics.at(-1).entries[0];
  assert.equal(entry.text, '某位参会者建议先验证');
  assert.deepEqual(entry.participantIds, []);
  assert.deepEqual(entry.evidenceIds, ['s1']);
  assert.equal(sources[0].participantId, 'unknown-a', 'internal storage identity remains intact');
});

test('explicitly naming or assigning an unknown utterance makes its confirmed identity available to AI', () => {
  const meeting = baseMeeting();
  meeting.participants.push({ id: 'placeholder', name: '', speakerIds: [], sourceIds: ['s'], identitySource: 'unassigned' });
  const source = { ...line('s', 'placeholder', '我建议先验证。'), speakerId: 'unknown' };
  assert.equal(sourceParticipantId(source, meeting), null);
  Object.assign(meeting.participants.at(-1), { name: '孙总', identitySource: 'manual' });
  assert.equal(sourceView([source], meeting)[0].participantId, 'placeholder');
  assert.equal(sourceView([source], meeting)[0].displayName, '孙总');
  assert.ok(knownContext(meeting, [source]).participants.some(person => person.id === 'placeholder'));
  const assigned = { ...source, participantId: 'p2' };
  assert.equal(sourceView([assigned], meeting)[0].participantId, 'p2');
  assert.equal(sourceView([assigned], meeting)[0].displayName, '李明');
  assert.equal(assigned.speakerId, 'unknown', 'the raw ASR label is not rewritten');
});

test('verified shared membership is passed to AI and grounded to the cited participant without merging groups', () => {
  const meeting = baseMeeting();
  meeting.participants.forEach(person => { person.memberId = 'member-sun'; person.name = '孙总'; });
  const source = line('s2', 'p2', '我建议先验证。');
  assert.equal(sourceView([source], meeting)[0].memberId, 'member-sun');
  const result = reduceOrganization(meeting, { topics: [{ id: 't', title: '验证安排', entries: [{ text: '[[person:p1]]建议验证', participantIds: ['p1'], evidence: [evidence(source)] }] }], followups: [] }, [source]);
  assert.equal(result.topics[0].entries[0].text, '[[person:p2]]建议验证');
  assert.deepEqual(result.topics[0].entries[0].participantIds, ['p2']);
  assert.equal(result.participants.length, 2);
  meeting.participants[0].memberId = null;
  const anonymous = reduceOrganization(meeting, { topics: [{ id: 't', title: '验证安排', entries: [{ text: '[[person:p1]]建议验证', participantIds: ['p1'], evidence: [evidence(source)] }] }], followups: [] }, [source]);
  assert.equal(anonymous.topics[0].entries[0].text, '某位参会者建议验证', 'equal display names alone do not link identities');
});

test('viewpoint attribution uses explicit source-grounded authors, not every cited speaker', () => {
  const meeting = baseMeeting(), a = line('s1', 'p1', '我建议先做验证。'), b = line('s2', 'p2', '为什么要先验证？');
  const result = reduceOrganization(meeting, { topics: [{ id: 't', title: '验证安排', summary: '[[person:outsider]]建议验证', summaryEvidence: [evidence(a)], entries: [
    { id: 'e1', text: '[[person:p1]]建议先验证，[[person:outsider]]也同意', participantIds: ['p1', 'outsider'], evidence: [evidence(a), evidence(b)] },
    { id: 'e2', text: '有人建议验证', evidence: [evidence(a), evidence(b)] },
  ] }], followups: [] }, [a, b]);
  const entries = result.topics[0].entries;
  assert.deepEqual(entries[0].participantIds, ['p1']);
  assert.deepEqual(entries[1].participantIds, []);
  assert.equal(entries[0].text, '[[person:p1]]建议先验证，某位参会者也同意');
  assert.doesNotMatch(result.topics[0].summary, /outsider/);
  assert.equal(entries[0].peopleFields.text, 1);
});

test('new structured AI results and minutes reflect rename with no extra model call', async t => {
  const { store, ai, calls } = fixture(t, data => ({ topics: [{ id: 't', title: '验证安排', summary: `${personReference(data.sources[0].participantId)}建议先验证`, summaryEvidence: [evidence(data.sources[0])], entries: [{ id: 'e', text: `${personReference(data.sources[0].participantId)}建议先验证`, participantIds: [data.sources[0].participantId], evidence: [evidence(data.sources[0])] }] }], followups: [] }));
  const m = store.createMeeting({ scenario: 'technical', title: '改名测试' });
  const source = store.appendTranscript(m.id, { text: '建议先验证并发。', speakerId: 'speaker-5' });
  const p = store.allTranscript(m.id)[0].participantId;
  store.updateParticipant(m.id, p, { name: '孙总' });
  const job = await finish(store, ai.submit(m.id, 'minutes'));
  assert.equal(job.status, 'done', job.error);
  assert.match(job.result.markdown, /\[\[person:/);
  const beforeCalls = calls.length;
  store.updateParticipant(m.id, p, { name: '孙先生' });
  assert.equal(ai.refreshSpeakers(m.id, [source.id], { kind: 'labels' }), null);
  assert.equal(calls.length, beforeCalls);
  const view = presentMeetingPeople(store.getMeeting(m.id));
  assert.match(view.topics[0].entries[0].text, /孙先生/);
  assert.match(view.artifacts[0].markdown, /孙先生/);
  assert.doesNotMatch(view.artifacts[0].markdown, /\[\[person:/);
});

function seedRecords(store) {
  const meeting = store.createMeeting({ scenario: 'technical', title: '会后更正身份', status: 'ended' });
  const source = store.appendTranscript(meeting.id, { text: '我建议先做并发验证，再决定上线。', speakerId: 'speaker-5' });
  const other = store.appendTranscript(meeting.id, { text: '文档周五更新。', speakerId: 'speaker-8' });
  const first = store.allTranscript(meeting.id).find(item => item.id === source.id).participantId;
  store.updateParticipant(meeting.id, first, { name: '旧名字' });
  const target = store.createParticipant(meeting.id, { name: '正确的人' }).participant.id;
  store.mutateMeeting(meeting.id, m => {
    m.status = 'ended';
    const text = `${personReference(first)}建议先验证`;
    m.topics = [{ id: 'topic', author: 'ai', title: '上线安排', summary: text, summaryEvidenceIds: [source.id], entries: [
      { id: 'entry', author: 'ai', type: 'viewpoint', status: 'active', text, evidenceIds: [source.id], participantIds: [first] },
      { id: 'host', author: 'host', type: 'viewpoint', status: 'active', text: '主持人写的旧名字不能自动改', evidenceIds: [source.id] },
      { id: 'other', author: 'ai', type: 'viewpoint', status: 'active', text: '文档周五更新', evidenceIds: [other.id] },
    ] }];
    m.followups = [{ id: 'f', author: 'ai', question: `${personReference(first)}还需要什么验证？`, rationale: text, impact: '影响上线安排', status: 'active', evidenceIds: [source.id], resolution: { author: 'ai', text, complete: false, evidenceIds: [source.id] } }];
    m.questions = [{ id: 'q', author: 'ai', question: '建议是什么？', answer: text, inference: '', evidenceIds: [source.id], evidence: [evidence(source)] }];
    m.artifacts = [{ id: 'a', author: 'ai', type: 'minutes', markdown: `${text} [原话](#transcript:${source.id})` }];
  });
  return { meeting, source, other, first, target };
}
const review = (data, oldId, newId) => ({ records: data.records.map(record => ({ id: record.id, text: record.text.replaceAll(personReference(oldId), personReference(newId)).replace('旧名字', personReference(newId)), evidence: record.evidenceIds.map(id => evidence(data.sources.find(line => line.id === id))), participantIds: [newId] })) });

test('attribution correction rechecks affected AI content in place after meeting ends and preserves manual/unrelated content', async t => {
  let first, target;
  const { store, ai, calls } = fixture(t, data => review(data, first, target));
  const seeded = seedRecords(store); ({ first, target } = seeded);
  const { affectedSourceIds } = store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, target);
  const before = store.getMeeting(seeded.meeting.id);
  assert.equal(before.topics[0].entries[0].stale, undefined);
  const result = await finish(store, ai.refreshSpeakers(seeded.meeting.id, affectedSourceIds));
  assert.equal(result.status, 'done', result.error);
  const saved = store.getMeeting(seeded.meeting.id);
  assert.equal(saved.status, 'ended');
  assert.equal(saved.topics[0].entries.length, 3);
  assert.equal(saved.topics[0].entries[0].id, 'entry');
  assert.equal(saved.topics[0].entries[0].text, `${personReference(target)}建议先验证`);
  assert.deepEqual(saved.topics[0].entries[0].participantIds, [target]);
  assert.equal(saved.topics[0].entries[0].identityReview, false);
  assert.equal(saved.topics[0].entries[1].text, before.topics[0].entries[1].text);
  assert.equal(saved.topics[0].entries[2].text, before.topics[0].entries[2].text);
  assert.equal(saved.followups[0].status, 'active');
  assert.equal(saved.followups[0].resolution.complete, false);
  assert.match(saved.questions[0].answer, new RegExp(target));
  assert.equal(saved.artifacts[0].stale, false);
  assert.ok(saved.artifacts[0].markdown.includes(`#transcript:${seeded.source.id}`));
  assert.ok(calls.every(data => data.records.every(record => !record.id.includes('/host/') && !record.id.includes('/other/'))));
});

test('legacy free text migrates only through explicit targeted review, never by global name replacement', async t => {
  let first, target;
  const { store, ai } = fixture(t, data => review(data, first, target));
  const seeded = seedRecords(store); ({ first, target } = seeded);
  store.mutateMeeting(seeded.meeting.id, m => { m.topics[0].entries[0].text = '旧名字建议先验证'; });
  store.updateParticipant(seeded.meeting.id, first, { name: '新名字' });
  // A label migration uses the same identity; the fixture returns its stable ID.
  target = first;
  const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id], { kind: 'labels' }));
  assert.equal(job.status, 'done', job.error);
  const meeting = store.getMeeting(seeded.meeting.id);
  assert.equal(meeting.topics[0].entries[0].text, `${personReference(first)}建议先验证`);
  assert.equal(presentMeetingPeople(meeting).topics[0].entries[0].text, '新名字建议先验证');
  assert.equal(meeting.topics[0].entries[1].text, '主持人写的旧名字不能自动改');
  assert.equal(ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id], { kind: 'labels' }), null);
});

test('invalid or missing refresh fields cannot partially publish or hide original viewpoints', async t => {
  const failures = {
    'foreign-person': /人物归属与引用的发言人不一致/,
    'missing-record': /未返回完整的发言人核对内容/,
    'unknown-record': /未返回完整的发言人核对内容/,
    'empty-text': /未返回完整的发言人核对内容/,
    'foreign-source': /原文引用未通过校验/,
    'misquoted-source': /原文引用未通过校验/,
    'citation-loss': /改动了纪要中的原文链接/,
  };
  for (const [bad, expectedError] of Object.entries(failures)) await t.test(bad, async t => {
    let first, target;
    const { store, ai } = fixture(t, data => {
      const output = review(data, first, target);
      if (bad === 'missing-record') output.records.pop();
      if (bad === 'unknown-record') output.records.at(-1).id = 'not-a-record';
      if (bad === 'empty-text') output.records.at(-1).text = '  ';
      if (bad === 'foreign-person') output.records.at(-1).text = '[[person:invented]]说可以上线';
      if (bad === 'foreign-source') output.records.at(-1).evidence = [{ id: 'not-in-meeting', quote: '伪造依据' }];
      if (bad === 'misquoted-source') output.records.at(-1).evidence[0].quote = '模型改写的句子';
      if (bad === 'citation-loss') output.records.find(record => record.id.includes('artifacts')).text = '没有保留原文链接';
      return output;
    });
    const seeded = seedRecords(store); ({ first, target } = seeded);
    store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, target);
    const before = store.getMeeting(seeded.meeting.id);
    const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]));
    assert.equal(job.status, 'error');
    assert.match(job.error, expectedError);
    assert.match(job.error, /本次未更新 AI 内容，已保存的姓名标记和原文不受影响/);
    const after = store.getMeeting(seeded.meeting.id);
    assert.deepEqual(after.participants, before.participants);
    assert.equal(store.allTranscript(seeded.meeting.id).find(line => line.id === seeded.source.id).participantId, target);
    assert.deepEqual(after.topics, before.topics);
    assert.deepEqual(after.followups, before.followups);
    assert.deepEqual(after.questions, before.questions);
    assert.deepEqual(after.artifacts, before.artifacts);
  });
});

test('a second attribution edit during refresh discards the old reply and reviews the latest identity', async t => {
  let seeded, replacement, changed = false;
  const { store, ai, calls } = fixture(t, data => {
    const current = data.sources.find(line => line.id === seeded.source.id).participantId;
    if (!changed) { changed = true; store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, replacement); }
    return review(data, seeded.first, current);
  });
  seeded = seedRecords(store);
  replacement = store.createParticipant(seeded.meeting.id, { name: '再次核对的人' }).participant.id;
  store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, seeded.target);
  const job = await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 2);
  const entry = store.getMeeting(seeded.meeting.id).topics[0].entries[0];
  assert.equal(entry.text, `${personReference(replacement)}建议先验证`);
  assert.ok(!entry.history.some(item => item.text?.includes(seeded.target)));
});

test('queued identity corrections coalesce source scope and remain serial with other meeting tasks', async t => {
  const { store, ai } = fixture(t, data => ({ records: data.records.map(record => ({ id: record.id, text: record.text, evidence: record.evidenceIds.map(id => evidence(data.sources.find(line => line.id === id))), participantIds: [] })) }));
  const seeded = seedRecords(store);
  await ai.stop();
  const a = ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id], { kind: 'labels' });
  const b = ai.refreshSpeakers(seeded.meeting.id, [seeded.other.id]);
  assert.equal(a.id, b.id);
  assert.deepEqual(new Set(b.input.sourceIds), new Set([seeded.source.id, seeded.other.id]));
  assert.equal(b.input.kind, 'attribution');
  ai.start();
  assert.equal((await finish(store, a)).status, 'done');
});

test('successive speaker edits wait for a quiet period and share one review', async t => {
  const { store, ai, calls } = fixture(t, data => ({ records: data.records.map(record => ({ id: record.id, unchanged: true })) }), { speakerDebounceMs: 60 });
  const seeded = seedRecords(store);
  const first = ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]);
  await new Promise(resolve => setTimeout(resolve, 35));
  const second = ai.refreshSpeakers(seeded.meeting.id, [seeded.other.id]);
  assert.equal(first.id, second.id);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls.length, 0, 'each edit resets the quiet period');
  assert.equal((await finish(store, second)).status, 'done');
  assert.equal(store.listJobs(seeded.meeting.id).length, 1);
  assert.equal(calls.length, 1);
  const ids = calls[0].records.map(record => record.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a new edit aborts an obsolete request and updates the same job with the latest identity', async t => {
  let seeded, replacement, aborted = false;
  const entered = Promise.withResolvers();
  const { store, ai, calls } = fixture(t, async (data, store, calls, signal) => {
    if (calls.length === 1) {
      entered.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    }
    return review(data, seeded.first, replacement);
  });
  seeded = seedRecords(store);
  replacement = store.createParticipant(seeded.meeting.id, { name: '最终确认的人' }).participant.id;
  store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, seeded.target);
  const first = ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]);
  await entered.promise;
  store.assignTranscriptParticipant(seeded.meeting.id, seeded.source.id, replacement);
  const second = ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]);
  assert.equal(second.id, first.id);
  const done = await finish(store, second);
  assert.equal(done.status, 'done', done.error);
  assert.equal(aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(store.listJobs(seeded.meeting.id).length, 1);
  assert.equal(store.getMeeting(seeded.meeting.id).topics[0].entries[0].text, `${personReference(replacement)}建议先验证`);
});

test('overlapping reviews reuse validated fields but recheck changes to text or cited identities', async t => {
  const { store, ai, calls } = fixture(t, data => ({ records: data.records.map(record => ({ id: record.id, unchanged: true })) }));
  const seeded = seedRecords(store);
  store.mutateMeeting(seeded.meeting.id, m => { m.topics[0].summaryEvidenceIds.push(seeded.other.id); });
  assert.equal((await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]))).status, 'done');
  const firstIds = new Set(calls[0].records.map(record => record.id));
  assert.equal((await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.other.id]))).status, 'done');
  assert.ok(calls[1].records.every(record => !firstIds.has(record.id)), 'shared title and summary are not sent twice');
  assert.equal(ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id, seeded.other.id]), null);
  store.mutateMeeting(seeded.meeting.id, m => { m.topics[0].summary += '，下周确认。'; });
  assert.equal((await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]))).status, 'done');
  assert.deepEqual(calls.at(-1).records.map(record => record.id), ['topics/topic/summary']);
  store.updateParticipant(seeded.meeting.id, seeded.first, { name: '新的身份名称' });
  assert.equal((await finish(store, ai.refreshSpeakers(seeded.meeting.id, [seeded.source.id]))).status, 'done');
  assert.ok(calls.at(-1).records.some(record => record.id === 'topics/topic/entries/entry/text'));
});

test('speaker review runs at most two batches concurrently and keeps validation attached to its own call', async t => {
  let active = 0, maxActive = 0;
  const { store, ai, calls } = fixture(t, async (data, store, calls) => {
    const callNumber = calls.length;
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, callNumber % 2 ? 25 : 5));
    active--;
    return { records: data.records.map(record => ({ id: record.id, unchanged: true })) };
  });
  const meeting = store.createMeeting({ scenario: 'technical', title: '长会议校对' });
  const lines = Array.from({ length: 13 }, (_, i) => store.appendTranscript(meeting.id, { speakerId: 'speaker-one', text: `第${i}段。${'原文依据。'.repeat(1400)}` }));
  store.mutateMeeting(meeting.id, m => {
    m.topics = [{ id: 'topic', title: '', entries: lines.map((line, i) => ({ id: `entry-${i}`, author: 'ai', type: 'viewpoint', text: `第${i}项建议`, evidenceIds: [line.id], participantIds: [line.participantId] })) }];
  });
  const result = await finish(store, ai.refreshSpeakers(meeting.id, lines.map(line => line.id)));
  assert.equal(result.status, 'done', result.error);
  assert.equal(maxActive, 2);
  assert.ok(calls.length >= 3);
  assert.equal(result.progress.completedRecords, 13);
  assert.equal(result.progress.completedBatches, calls.length);
  result.modelCalls.forEach((call, index) => {
    assert.equal(call.validation.status, 'passed');
    assert.equal(call.validation.checkedRecords, calls[index].records.length);
  });
});

test('AI answer person references must be backed by the answer citations', async t => {
  const { store, ai } = fixture(t, data => ({ answer: `[[person:foreign]]反对，${personReference(data.sources[0].participantId)}建议验证`, inference: '', evidence: [evidence(data.sources[0])], insufficient: false }));
  const m = store.createMeeting({ scenario: 'technical', title: '回答身份来源' });
  store.appendTranscript(m.id, { text: '我建议先验证。', speakerId: 'speaker-1' });
  const job = await finish(store, ai.submit(m.id, 'answer', { question: '有什么建议？' }));
  assert.equal(job.status, 'done', job.error);
  assert.doesNotMatch(job.result.answer, /foreign/);
  assert.match(job.result.answer, /某位参会者反对/);
  assert.equal(job.result.peopleFields.answer, 1);
});

test('manual fields and original transcription are never migration targets', () => {
  const m = baseMeeting(), source = line('s1', 'p1', '孙总是我的原话。');
  m.topics = [{ id: 't', title: '孙总事项', summary: '人工摘要', manualFields: ['summary'], summaryEvidenceIds: ['s1'], entries: [{ id: 'e', author: 'agent', text: '孙总已确认', evidenceIds: ['s1'] }] }];
  m.followups = [{ id: 'f', author: 'host', question: '主持人问题', evidenceIds: ['s1'], resolution: { author: 'host', text: '主持人结果', evidenceIds: ['s1'] } }];
  const records = peopleReviewRecords(m, [source], ['s1'], 'labels');
  assert.deepEqual(records.map(record => record.id), ['topics/t/title']);
  assert.equal(source.text, '孙总是我的原话。');
});

test('an explicit first-person task keeps its grounded owner without requiring a self-name in the quote', () => {
  const meeting = baseMeeting();
  const commitment = line('s1', 'p1', '我明天负责接口联调。');
  const report = line('s2', 'p2', '接口明天需要联调。');
  const result = reduceOrganization(meeting, { topics: [{ id: 't', title: '联调', entries: [
    { type: 'action', text: '负责接口联调', owner: '[[person:p1]]', due: '明天', evidence: [evidence(commitment)] },
    { type: 'action', text: '另一项待分配联调', owner: '[[person:p2]]', evidence: [evidence(report)] },
    { type: 'action', text: '错误归属联调', owner: '[[person:p2]]', evidence: [evidence(commitment)] },
  ] }], followups: [] }, [commitment, report]);
  const entries = result.topics[0].entries;
  assert.equal(entries[0].owner, '[[person:p1]]');
  assert.equal(entries[1].owner, undefined);
  assert.equal(entries[2].owner, undefined);
});


test('a third-person named assignee remains literal and is not mistaken for the cited speaker', () => {
  const meeting = baseMeeting();
  const name = meeting.participants.find(person => person.id === 'p2').name;
  const source = line('s1', 'p1', `${name}明天整理验收标准。`);
  const result = reduceOrganization(meeting, { topics: [{ id: 't', title: '验收', entries: [
    { type: 'action', text: '整理验收标准', owner: '[[person:p2]]', evidence: [evidence(source)] },
  ] }], followups: [] }, [source]);
  assert.equal(result.topics[0].entries[0].owner, name);
  assert.deepEqual(result.topics[0].entries[0].participantIds, []);
});
