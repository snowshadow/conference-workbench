import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasUnstructuredPeopleName, markPeopleFields, peopleReviewRecords } from '../server/ai/people.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { createAIService } from '../server/ai/service.js';
import { Store } from '../server/store.js';
import { presentMeetingPeople } from '../shared/people.js';

const line = { id: 'source', meetingId: 'm', participantId: 'person', speakerId: 'speaker-1', text: '画像栏目固定，用户内容可以更新。', revision: 1, origin: 'asr', startMs: 0 };
const evidence = [{ id: line.id, quote: line.text }];
const base = () => ({ id: 'm', transcriptRevision: 1, topics: [], followups: [], participants: [{ id: 'person', name: '陈小林', speakerIds: ['speaker-1'] }] });
const followup = () => ({ id: 'new', kind: 'concept', question: '画像固定，为什么又能更新？', rationale: '栏目和具体内容混在了一起。', impact: '影响更新范围。', evidence,
  clarification: { explanation: '陈小林讲的是栏目固定，用户内容可变。', evidence, distinctions: [{ title: '用户内容', text: '内容可以更新。', example: '陈小林举的是偏好变化的例子。', evidence }] },
});

test('literal participant names stay pending instead of being mistaken for structured identities', () => {
  const meeting = reduceOrganization(base(), { followups: [followup()] }, [line]);
  const item = meeting.followups[0];
  assert.equal(item.clarification.peopleFields.explanation, 0);
  assert.equal(item.clarification.distinctions[0].peopleFields.example, 0);
  assert.equal(item.clarification.distinctions[0].peopleFields.text, 1);
  assert.equal(item.peopleFields.question, 1);
  assert.equal(item.clarification.explanation, followup().clarification.explanation, 'no automatic replacement');
  assert.deepEqual(item.clarification.evidence.map(({ id, quote }) => ({ id, quote })), evidence);
  meeting.participants[0].name = '新的姓名';
  const records = peopleReviewRecords(meeting, [line], [line.id], 'labels');
  assert.deepEqual(records.map(record => record.field).sort(), ['example', 'explanation']);
  assert.equal(records[0].text, followup().clarification.explanation, 'renaming schedules review without rewriting existing facts');
});

test('correct references update immediately while generic text does not require another model call', () => {
  const input = followup();
  input.clarification.explanation = '[[person:person]]讲的是栏目固定，用户内容可变。';
  delete input.clarification.distinctions[0].example;
  const meeting = reduceOrganization(base(), { followups: [input] }, [line]);
  assert.equal(meeting.followups[0].clarification.peopleFields.explanation, 1);
  meeting.participants[0].name = '新的姓名';
  assert.deepEqual(peopleReviewRecords(meeting, [line], [line.id], 'labels'), []);
  assert.match(presentMeetingPeople(meeting).followups[0].clarification.explanation, /^新的姓名讲的是/);
});

test('old incorrect completion markers are rechecked read-only when their current names remain recognizable', () => {
  const meeting = reduceOrganization(base(), { followups: [followup()] }, [line]);
  meeting.followups[0].clarification.peopleFields.explanation = 1;
  const before = structuredClone(meeting);
  assert.ok(peopleReviewRecords(meeting, [line], [line.id], 'labels').some(record => record.field === 'explanation'));
  assert.deepEqual(meeting, before, 'reading legacy records must not rewrite persisted data');
  meeting.followups[0].clarification.manualFields = ['explanation'];
  assert.ok(!peopleReviewRecords(meeting, [line], [line.id], 'labels').some(record => record.field === 'explanation'));
});

test('name detection excludes stable references and word substrings, without assigning mentioned third parties', () => {
  const meeting = base();
  meeting.participants.push({ id: 'single', name: '甲' }, { id: 'latin', name: 'Ann' });
  for (const text of ['甲方负责验收。', 'Planning starts tomorrow.', 'Anna确认上线。', '[[person:person]]建议先验证。']) assert.equal(hasUnstructuredPeopleName(text, meeting), false, text);
  for (const text of ['甲：先验证。', 'Ann 认为需要验证。', 'Ann认为需要验证。', '陈小林讲的是栏目。', '[[person:person]]提到了陈小林的说法。']) assert.equal(hasUnstructuredPeopleName(text, meeting), true, text);
  const item = { text: '有人转述陈小林的说法。', evidence: [{ id: 'source', quote: '陈小林说栏目固定。' }], participantIds: [] };
  markPeopleFields(item, ['text'], meeting);
  assert.equal(item.peopleFields.text, 0);
  assert.equal(item.text, '有人转述陈小林的说法。');
  assert.equal(item.evidence[0].quote, '陈小林说栏目固定。');
  assert.deepEqual(item.participantIds, [], 'a mention does not become viewpoint attribution');
});

test('AI resolutions and retirement explanations receive the same name review markers', () => {
  const initial = reduceOrganization(base(), { followups: [followup()] }, [line]);
  const id = initial.followups[0].id;
  const updated = reduceOrganization(initial, {
    resolvedFollowups: [{ id, evidence, resolution: { outcome: 'clarified', text: '陈小林解释了栏目范围。', complete: false } }],
    retiredFollowups: [{ id, evidence, reason: '陈小林已经解释所指对象，暂不需要停在这里。' }],
  }, [line]);
  assert.equal(updated.followups[0].resolution.peopleFields.text, 0);
  assert.equal(updated.followups[0].attention.peopleFields.reason, 0);
});

test('a rename reviews generated plain names and completes with stable references using the existing AI job', async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-plain-names-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  let participantId;
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content);
    calls.push(data);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ records: data.records.map(record => ({ id: record.id, text: record.text.replaceAll('陈小林', `[[person:${participantId}]]`), evidence: record.evidenceIds.map(id => ({ id, quote: data.sources.find(item => item.id === id).text })) })) }) } }] });
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  const meeting = store.createMeeting({ title: '姓名刷新' });
  const source = store.appendTranscript(meeting.id, { text: line.text, speakerId: 'speaker-1' });
  const lines = store.allTranscript(meeting.id);
  participantId = lines[0].participantId;
  store.updateParticipant(meeting.id, participantId, { name: '陈小林' });
  const input = followup();
  const supported = [{ id: source.id, quote: source.text }];
  input.evidence = supported;
  input.clarification.evidence = supported;
  input.clarification.distinctions[0].evidence = supported;
  store.mutateMeeting(meeting.id, current => Object.assign(current, reduceOrganization(current, { followups: [input] }, lines)));
  store.updateParticipant(meeting.id, participantId, { name: '陈先生' });
  const job = ai.refreshSpeakers(meeting.id, [source.id], { kind: 'labels' });
  assert.ok(job);
  let result;
  for (let i = 0; i < 1200; i++) {
    result = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.equal(result.status, 'done', result.error);
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.followups[0].clarification.peopleFields.explanation, 1);
  assert.match(presentMeetingPeople(saved).followups[0].clarification.explanation, /^陈先生/);
  assert.deepEqual(calls.flatMap(call => call.records).map(record => record.id.split('/').at(-1)).sort(), ['example', 'explanation']);
  assert.equal(ai.refreshSpeakers(meeting.id, [source.id], { kind: 'labels' }), null);
});
