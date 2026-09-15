import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceOrganization } from '../server/ai/reducer.js';
import { knownContext } from '../server/ai/context.js';
import { peopleRecordTarget, peopleReviewRecords } from '../server/ai/people.js';
import { createAIService } from '../server/ai/service.js';
import { Store } from '../server/store.js';
import { isActiveFocus, recommendedFocusId } from '../shared/discussion-view.js';
import { presentMeetingPeople } from '../shared/people.js';

const source = (id, text, participantId = 'p1', startMs = 0) => ({ id, meetingId: 'm', text, participantId, speakerId: `raw-${participantId}`, revision: 1, origin: 'asr', startMs });
const a = source('a', '画像固定的是产品规定的标签范围。');
const b = source('b', '每个用户的具体画像当然可以更新。', 'p2', 1000);
const c = source('c', '更新不一定覆盖原来的内容。', 'p1', 2000);
const lines = [a, b, c];
const evidence = line => [{ id: line.id, quote: line.text }];
const base = () => ({ id: 'm', transcriptRevision: 3, topics: [], followups: [], participants: [{ id: 'p1', name: '甲', speakerIds: ['raw-p1'] }, { id: 'p2', name: '乙', speakerIds: ['raw-p2'] }] });
const distinction = (line, extra = {}) => ({ title: '用户的具体画像', text: line.text, evidence: evidence(line), ...extra });
const explanation = (extra = {}) => ({ explanation: '这里混用了画像栏目和用户的具体画像。', evidence: evidence(a), distinctions: [distinction(b)], ...extra });
const question = (id = 'new', extra = {}) => ({ id, question: '画像固定，为什么又能更新？', rationale: '同一个词指向了不同的对象。', impact: '会影响更新哪些数据。', kind: 'concept', evidence: evidence(a), clarification: explanation(), ...extra });
const organize = (meeting, payload, sources = lines, sourceRevision = 3) => reduceOrganization(meeting, payload, sources, { sourceRevision, followupLimit: 3 });
const seeded = () => organize(base(), { followups: [question()], focusFollowupId: 'new' });
const retirement = id => ({ id, reason: '当前不涉及修改栏目，先继续讨论用户内容如何更新。', evidence: evidence(c) });

test('explanations accept zero, one and several distinctions and retain every nested source', () => {
  for (const count of [0, 1, 3]) {
    const parts = [distinction(b), distinction(c, { title: '内容的更新' }), distinction(a, { title: '画像栏目' })].slice(0, count);
    const meeting = organize(base(), { followups: [question('new', { clarification: explanation({ distinctions: parts }) })] });
    const item = meeting.followups[0];
    assert.equal(item.clarification.distinctions.length, count);
    assert.equal(item.clarification.author, 'ai');
    assert.equal(item.clarification.sourceRevision, 3);
    assert.deepEqual(new Set(item.evidenceIds), new Set(['a', ...parts.flatMap(part => part.evidence.map(ref => ref.id))]));
    assert.ok(item.clarification.distinctions.every(part => part.id && part.evidence[0].revision === 1));
    assert.equal(new Set(item.clarification.distinctions.map(part => part.id)).size, count);
  }
});

test('a source outside the meeting or a fabricated nested quote cannot publish an explanation', () => {
  for (const bad of [{ id: 'foreign', quote: b.text }, { id: b.id, quote: '没有说过的话' }]) {
    const badExplanation = explanation({ distinctions: [distinction(b, { evidence: [bad] })] });
    assert.equal(organize(base(), { followups: [question('new', { clarification: badExplanation })] }).followups.length, 0);
    const meeting = seeded(), id = meeting.followups[0].id;
    const updated = organize(meeting, { followups: [question(id, { clarification: badExplanation })] });
    assert.deepEqual(updated.followups[0], meeting.followups[0], 'invalid updates retain the previous explanation');
  }
});

test('each explanation field grounds people against its own citations and names remain dynamic', () => {
  const meeting = organize(base(), { followups: [question('new', { clarification: explanation({
    explanation: '[[person:p1]]说的是栏目；[[person:p2]]的说法需要另找依据。',
    distinctions: [distinction(b, { title: '[[person:p2]]的画像内容', text: '[[person:p2]]说内容可以更新。', example: '[[person:p1]]的例子没有引用依据。' })],
  }) })] });
  const item = meeting.followups[0];
  assert.match(item.clarification.explanation, /\[\[person:p1\]\]/);
  assert.match(item.clarification.explanation, /某位参会者的说法/);
  assert.match(item.clarification.distinctions[0].example, /^某位参会者/);
  meeting.participants[0].name = '新甲'; meeting.participants[1].name = '新乙';
  const view = presentMeetingPeople(meeting).followups[0];
  assert.match(view.clarification.explanation, /^新甲/);
  assert.equal(view.clarification.distinctions[0].title, '新乙的画像内容');
  assert.deepEqual(view.clarification.evidence, item.clarification.evidence, 'quoted source text is not rewritten');
});

test('incremental clarification updates keep question/card IDs and the former explanation in history', () => {
  const meeting = seeded(), item = meeting.followups[0], partId = item.clarification.distinctions[0].id;
  const updated = organize(meeting, { followups: [{ id: item.id, evidence: evidence(a), clarification: explanation({ evidence: evidence(c), explanation: '栏目保持固定，每个人的具体内容可以变化，更新也不等于覆盖。', distinctions: [distinction(b, { title: '某个人的画像内容' })] }) }] }, lines, 4);
  const current = updated.followups[0];
  assert.equal(current.id, item.id);
  assert.equal(current.question, item.question);
  assert.equal(current.clarification.distinctions[0].id, partId);
  assert.equal(current.history.at(-1).clarification.explanation, item.clarification.explanation);
  assert.equal(current.clarification.sourceRevision, 4);
  const context = knownContext(updated, lines).existingFollowups[0].clarification;
  assert.equal(context.explanation, current.clarification.explanation);
  assert.deepEqual(context.evidenceIds, current.clarification.evidenceIds);
  assert.equal(context.distinctions[0].id, partId);
  assert.equal(context.evidence, undefined);
  assert.equal(context.distinctions[0].evidence, undefined);
  const late = organize(updated, { followups: [question(item.id)] }, lines, 2);
  assert.deepEqual(late.followups[0], current);
});

test('an unchanged evidence set cannot rewrite an established explanation or grow history on every check', () => {
  const meeting = seeded(), id = meeting.followups[0].id;
  const unchanged = organize(meeting, { followups: [question(id)] }, lines, 4);
  assert.equal(unchanged.followups[0].clarification.sourceRevision, 4);
  assert.equal(unchanged.followups[0].history?.length || 0, 0);
  const rewritten = organize(unchanged, { followups: [question(id, { clarification: explanation({ explanation: '模型换了一种看法，却没有新的发言依据。' }) })] }, lines, 5);
  assert.deepEqual(rewritten.followups[0].clarification, unchanged.followups[0].clarification);
  assert.equal(rewritten.followups[0].history?.length || 0, 0);
  const unrelatedEdit = structuredClone(meeting); unrelatedEdit.followups[0].stale = true;
  assert.equal(organize(unrelatedEdit, { followups: [question(id, { clarification: explanation({ explanation: '别处原文改了，不能借此重写这一段。' }) })] }).followups[0].clarification.explanation, meeting.followups[0].clarification.explanation);
  const old = structuredClone(meeting); delete old.followups[0].clarification;
  const filled = organize(old, { followups: [question(id)] });
  assert.ok(filled.followups[0].clarification, 'legacy records can gain their first explanation');
  const stale = structuredClone(meeting); stale.followups[0].clarification.stale = true;
  const rechecked = organize(stale, { followups: [question(id, { clarification: explanation({ explanation: '原文核对后的解释。' }) })] });
  assert.equal(rechecked.followups[0].clarification.explanation, '原文核对后的解释。');
  assert.equal(rechecked.followups[0].clarification.stale, false);
});

test('legacy partial progress can gain its first explanation while an unsupported rewritten question is ignored', () => {
  let meeting = organize(base(), { followups: [question('new', { clarification: undefined, shortQuestion: '画像的哪部分固定？', discussionValue: '区分栏目和内容。' })] });
  const id = meeting.followups[0].id;
  meeting = organize(meeting, { resolvedFollowups: [{ id, resolution: { outcome: 'clarified', text: '用户内容可以更新，覆盖方式仍待讨论。', complete: false }, evidence: evidence(b) }] });
  const previous = structuredClone(meeting.followups[0]);
  const updated = organize(meeting, { followups: [question(id, { question: '是否已经决定覆盖所有画像？', rationale: '试图重写问题。', shortQuestion: '已决定覆盖？', discussionValue: '不同的展示文案。' })] });
  const item = updated.followups[0];
  assert.ok(item.clarification);
  for (const key of ['question', 'rationale', 'impact', 'shortQuestion', 'discussionValue', 'evidence', 'resolution', 'status']) assert.deepEqual(item[key], previous[key]);
  assert.deepEqual(new Set(item.evidenceIds), new Set(['a', 'b']));
});

test('host-authored nested explanations and manually protected fields survive model updates', () => {
  for (const protect of [
    item => { item.manualFields = ['clarification']; },
    item => { item.clarification.author = 'host'; },
    item => { item.clarification.manualFields = ['explanation']; },
    item => { item.clarification.distinctions[0].author = 'agent'; },
    item => { item.clarification.distinctions[0].manualFields = ['text']; },
  ]) {
    const meeting = seeded(), item = meeting.followups[0]; protect(item);
    const updated = organize(meeting, { followups: [question(item.id, { clarification: explanation({ explanation: '试图替换人工说明。' }) })], retiredFollowups: [retirement(item.id)] }, lines, 4);
    assert.deepEqual(updated.followups[0].clarification, item.clarification);
    assert.equal(updated.followups[0].attention, undefined);
  }
});

test('a changed question never shows its old explanation as current', () => {
  const meeting = seeded(), id = meeting.followups[0].id;
  const updated = organize(meeting, { followups: [question(id, { question: '更新是否覆盖历史内容？', evidence: evidence(c), clarification: undefined })] });
  assert.equal(updated.followups[0].question, '更新是否覆盖历史内容？');
  assert.equal(updated.followups[0].clarification.stale, true);
});

test('retirement leaves the unresolved fact intact and advances to another eligible focus', () => {
  const meeting = seeded(), id = meeting.followups[0].id;
  meeting.followups.push({ id: 'next', status: 'active', author: 'ai', question: '增量更新的触发条件是什么？' });
  const updated = organize(meeting, { retiredFollowups: [retirement(id)] });
  const item = updated.followups[0];
  assert.equal(item.status, 'active');
  assert.equal(item.resolution, undefined);
  assert.equal(item.attention.needed, false);
  assert.deepEqual(item.attention.evidenceIds, ['c']);
  assert.equal(item.attention.author, 'ai');
  assert.deepEqual(new Set(item.evidenceIds), new Set(['a', 'b', 'c']));
  assert.equal(item.history.at(-1).attention, undefined);
  assert.equal(isActiveFocus(item), false);
  assert.equal(updated.focusFollowupId, 'next');
  assert.equal(recommendedFocusId({ ...updated, focusFollowupId: id }), 'next');
  const attention = knownContext(updated, lines).existingFollowups[0].attention;
  assert.equal(attention.needed, false);
  assert.equal(attention.reason, item.attention.reason);
  assert.deepEqual(attention.evidenceIds, ['c']);
  assert.equal(attention.evidence, undefined);
  assert.equal(organize(meeting, { retiredFollowups: [retirement(id)], focusFollowupId: null }).focusFollowupId, null);
});

test('retirement cannot override handled, authored, merged or newer questions and needs source support', () => {
  for (const change of [
    item => { item.status = 'recorded'; },
    item => { item.status = 'resolved'; },
    item => { item.status = 'ignored'; },
    item => { item.author = 'host'; },
    item => { item.manualFields = ['shortQuestion']; },
    item => { item.manualFields = ['resolution']; },
    item => { item.attention = { needed: true, reason: '主持人希望继续讨论。', manualFields: ['reason'] }; },
    item => { item.resolution = { author: 'agent', text: '主持人保留的记录。' }; },
    item => { item.sourceRevision = 5; },
    item => { item.mergedInto = 'other'; },
  ]) {
    const meeting = seeded(), item = meeting.followups[0]; change(item);
    assert.deepEqual(organize(meeting, { retiredFollowups: [retirement(item.id)] }).followups[0], item);
  }
  const meeting = seeded(), id = meeting.followups[0].id;
  for (const bad of [{ ...retirement(id), evidence: [{ id: 'foreign', quote: c.text }] }, { ...retirement(id), reason: '' }]) {
    assert.deepEqual(organize(meeting, { retiredFollowups: [bad] }).followups[0], meeting.followups[0]);
  }
});

test('keep and reworded old evidence never revive a retired issue; new evidence plus explanation can', () => {
  const initial = seeded(), id = initial.followups[0].id;
  const retired = organize(initial, { retiredFollowups: [retirement(id)] });
  const kept = organize(retired, { keepFollowupIds: [id], focusFollowupId: id }, lines, 4);
  assert.equal(kept.followups[0].attention.needed, false);
  assert.equal(kept.focusFollowupId, null);
  const rephrased = organize(retired, { followups: [question(id, { clarification: explanation({ explanation: '这是更好读的解释。' }) })], focusFollowupId: id }, lines, 4);
  assert.equal(rephrased.followups[0].attention.needed, false);
  const cropped = organize(retired, { followups: [question(id, { evidence: [{ id: c.id, quote: '更新不一定覆盖' }] })] }, lines, 4);
  assert.equal(cropped.followups[0].attention.needed, false);
  const d = source('d', '现在考虑让用户自定义画像栏目，会影响更新范围。', 'p2', 3000);
  const withoutExplanation = organize(retired, { followups: [question(id, { evidence: evidence(d), clarification: undefined })] }, [...lines, d], 4);
  assert.equal(withoutExplanation.followups[0].attention.needed, false);
  const revived = organize(retired, { followups: [question(id, { evidence: evidence(d), clarification: explanation({ evidence: evidence(d), explanation: '新增用户自定义栏目后，需要再区分栏目变化和内容变化。' }) })], focusFollowupId: id }, [...lines, d], 4);
  assert.equal(revived.followups[0].attention.needed, true);
  assert.equal(revived.followups[0].status, 'active');
  assert.equal(revived.focusFollowupId, id);
  assert.equal(revived.followups[0].history.at(-1).attention.needed, false);
});

test('changes to an explanation-only source invalidate the explanation and cannot be cleared by keep', t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-clarification-')));
  t.after(() => store.close());
  const meeting = store.createMeeting({ title: '画像定义' });
  const first = store.appendTranscript(meeting.id, { text: a.text, speakerId: 'speaker-1' });
  const second = store.appendTranscript(meeting.id, { text: b.text, speakerId: 'speaker-2' });
  store.mutateMeeting(meeting.id, current => {
    const output = reduceOrganization(current, { followups: [question('new', { evidence: evidence(first), clarification: explanation({ evidence: evidence(first), distinctions: [distinction(second)] }) })] }, store.allTranscript(meeting.id));
    current.followups = output.followups;
  });
  const id = store.getMeeting(meeting.id).followups[0].id;
  store.editTranscript(meeting.id, second.id, { text: '原文已更正，不再支持此前的解释。' });
  const current = store.getMeeting(meeting.id);
  assert.equal(current.followups[0].stale, true);
  assert.equal(current.followups[0].clarification.stale, true);
  assert.equal(current.followups[0].clarification.distinctions[0].stale, true);
  const kept = reduceOrganization(current, { keepFollowupIds: [id] }, store.allTranscript(meeting.id));
  assert.equal(kept.followups[0].stale, true);
});

test('nested identity review targets explanation, examples and retirement reasons without touching manual text', () => {
  const initial = seeded(), id = initial.followups[0].id;
  const meeting = organize(initial, { retiredFollowups: [retirement(id)] });
  const item = meeting.followups[0];
  item.clarification.distinctions[0].example = '乙的具体画像可以更新。';
  const records = peopleReviewRecords(meeting, lines, ['a', 'b', 'c']);
  for (const field of ['explanation', 'title', 'text', 'example', 'reason']) assert.ok(records.some(record => record.field === field));
  for (const record of records) assert.equal(peopleRecordTarget(meeting, record.path)[record.field], record.text);
  item.manualFields = ['clarification', 'attention'];
  assert.ok(peopleReviewRecords(meeting, lines, ['a', 'b', 'c']).every(record => !record.path.includes('clarification') && !record.path.includes('attention')));
  item.clarification.explanation = '人工保留 [[person:p1]]';
  assert.equal(presentMeetingPeople(meeting).followups[0].clarification.explanation, item.clarification.explanation);
});

test('speaker attribution refresh updates nested explanation fields in place without losing their evidence', async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-clarification-people-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture' } });
  let from, to;
  const ai = createAIService({ store, fetchImpl: async (_, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ records: data.records.map(record => ({ id: record.id, text: record.text.replaceAll(`[[person:${from}]]`, `[[person:${to}]]`), evidence: record.evidenceIds.map(id => ({ id, quote: data.sources.find(source => source.id === id).text })) })) }) } }] });
  } });
  ai.start(); t.after(async () => { await ai.stop(); store.close(); });
  const created = store.createMeeting({ title: '说话人修正' });
  const original = store.appendTranscript(created.id, { text: a.text, speakerId: 'speaker-1' });
  from = original.participantId;
  to = store.createParticipant(created.id, { name: '正确的人' }).participant.id;
  store.mutateMeeting(created.id, current => {
    const ref = `[[person:${from}]]`;
    current.followups = reduceOrganization(current, { followups: [question('new', { evidence: evidence(original), clarification: explanation({ explanation: `${ref}说的是栏目范围。`, evidence: evidence(original), distinctions: [distinction(original, { title: `${ref}的说法`, text: `${ref}说明栏目固定。`, example: `${ref}以画像标签为例。` })] }) })] }, store.allTranscript(created.id)).followups;
  });
  const before = store.getMeeting(created.id).followups[0];
  store.assignTranscriptParticipant(created.id, original.id, to);
  const job = ai.refreshSpeakers(created.id, [original.id]);
  let finished;
  for (let i = 0; i < 1000; i++) {
    finished = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(finished.status)) break;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.equal(finished.status, 'done', finished.error);
  const after = store.getMeeting(created.id).followups[0];
  assert.equal(after.id, before.id);
  assert.equal(after.clarification.distinctions[0].id, before.clarification.distinctions[0].id);
  assert.match(after.clarification.explanation, new RegExp(to));
  for (const field of ['title', 'text', 'example']) assert.match(after.clarification.distinctions[0][field], new RegExp(to));
  assert.deepEqual(after.evidenceIds, before.evidenceIds);
  assert.deepEqual(after.clarification.evidence, before.clarification.evidence);
  assert.equal(after.clarification.history.at(-1).explanation, before.clarification.explanation);
});
