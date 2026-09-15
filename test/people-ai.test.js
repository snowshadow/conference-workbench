import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { sourceView } from '../server/ai/retrieval.js';
import { knownContext } from '../server/ai/context.js';
import { allowedPeople, peopleReviewRecords, sourceParticipantId } from '../server/ai/people.js';
import { isUnassignedUtterance, participantFor, personReference, presentMeetingPeople, presentPeopleValue, resolvePeopleText, speakerName } from '../shared/people.js';

const response = output => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
function fixture(t, responder) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-people-ai-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push(data); return response(await responder(data, store, calls));
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
  const m = store.createMeeting({ title: '改名测试' });
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
  const meeting = store.createMeeting({ title: '会后更正身份', status: 'ended' });
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

test('AI answer person references must be backed by the answer citations', async t => {
  const { store, ai } = fixture(t, data => ({ answer: `[[person:foreign]]反对，${personReference(data.sources[0].participantId)}建议验证`, inference: '', evidence: [evidence(data.sources[0])], insufficient: false }));
  const m = store.createMeeting({ title: '回答身份来源' });
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
