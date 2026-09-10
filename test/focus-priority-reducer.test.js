import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceOrganization } from '../server/ai/reducer.js';
import { knownContext } from '../server/ai/context.js';
import { peopleRecordTarget, peopleReviewRecords } from '../server/ai/people.js';
import { presentMeetingPeople } from '../shared/people.js';
import { createAIService } from '../server/ai/service.js';
import { Store } from '../server/store.js';

const a = { id: 'a', meetingId: 'm', text: '如果栏目和用户信息混在一起，更新接口就得重做。', participantId: 'p1', speakerId: 'speaker-1', revision: 1, origin: 'asr', startMs: 0 };
const b = { ...a, id: 'b', text: '栏目不变，内容可以更新；这个区别先说清再定接口。', participantId: 'p2', speakerId: 'speaker-2', startMs: 1000 };
const lines = [a, b];
const refs = line => [{ id: line.id, quote: line.text }];
const base = () => ({ id: 'm', transcriptRevision: 3, topics: [], followups: [], participants: [{ id: 'p1', name: '陈明', speakerIds: ['speaker-1'] }, { id: 'p2', name: '王琳', speakerIds: ['speaker-2'] }] });
const question = (extra = {}) => ({ id: 'new_focus', kind: 'concept', question: '画像固定的是栏目还是内容？', rationale: '固定的对象没有对齐。', impact: '影响更新接口的设计。', evidence: refs(a), ...extra });
const rank = (level = 'high', reason = '这个区别会改变接下来要定的更新接口。') => ({ level, reason });
const reduce = (meeting, payload, sourceRevision = 3, sources = lines) => reduceOrganization(meeting, payload, sources, { sourceRevision, followupLimit: 2 });
const seed = (priority) => reduce(base(), { followups: [question({ ...(priority ? { priority } : {}) })], focusFollowupId: 'new_focus' });
const update = (meeting, priority = rank(), extra = {}, sourceRevision = 4) => reduce(meeting, { followups: [{ id: meeting.followups[0].id, priority, evidence: refs(a), ...extra }] }, sourceRevision);

test('new focus stores an optional coarse priority with the already validated source', () => {
  for (const level of ['high', 'medium', 'low']) {
    const current = seed(rank(level)).followups[0];
    assert.equal(current.priority.level, level);
    assert.equal(current.priority.author, 'ai');
    assert.equal(current.priority.sourceRevision, 3);
    assert.equal(current.priority.stale, false);
    assert.deepEqual(current.priority.evidence, current.evidence);
    assert.deepEqual(current.priority.evidenceIds, ['a']);
    assert.equal(current.status, 'active');
    assert.equal(current.resolution, undefined);
  }
  assert.equal(seed().followups[0].priority, undefined, 'older model output remains compatible');
});

test('priority-only updates preserve facts, question and history, including partial progress', () => {
  const meeting = seed();
  const current = meeting.followups[0];
  current.resolution = { outcome: 'clarified', text: '栏目保持不变，更新接口待定。', complete: false, author: 'ai', evidence: [{ ...refs(b)[0], revision: 1 }], evidenceIds: ['b'], sourceRevision: 3 };
  current.history = [{ question: '以前的提问。' }];
  let updated = update(meeting);
  for (let revision = 5; revision < 12; revision++) updated = update(updated, rank(revision % 2 ? 'medium' : 'high'), {}, revision);
  const { priority, ...rest } = updated.followups[0];
  assert.deepEqual(rest, current);
  assert.equal(priority.sourceRevision, 11);
  assert.equal(updated.focusFollowupId, meeting.focusFollowupId);
  assert.equal(updated.followups[0].history.length, 1);
});

test('priority updates reject invalid levels, missing reasons and ungrounded source claims', () => {
  const meeting = seed(rank());
  for (const priority of [rank('critical'), rank('HIGH'), rank('high', ''), rank('high', ' '), rank('high', 'x'.repeat(601)), [], null, { level: 'low' }]) {
    assert.deepEqual(update(meeting, priority).followups[0], meeting.followups[0]);
  }
  for (const evidence of [[], [{ id: 'foreign', quote: a.text }], [{ id: 'a', quote: '完全没有说过的话。' }]]) {
    assert.deepEqual(update(meeting, rank('low'), { evidence }).followups[0], meeting.followups[0]);
  }
  const next = seed(rank('critical')).followups[0];
  assert.equal(next.priority, undefined, 'an invalid model label can never enter sorting');
});

test('older rank cannot replace a newer rank or update content freshness', () => {
  const current = update(seed(), rank('medium'), {}, 9);
  const late = update(current, rank('high'), {}, 8);
  assert.deepEqual(late.followups[0], current.followups[0]);
  assert.equal(late.followups[0].sourceRevision, 3, 'ranking does not claim to have reviewed the factual record');
});

test('priority-only changes cannot revive retired or finished issues or overwrite host work', () => {
  for (const protect of [
    item => { item.status = 'resolved'; },
    item => { item.status = 'recorded'; },
    item => { item.status = 'ignored'; },
    item => { item.status = 'merged'; item.mergedInto = 'other'; },
    item => { item.attention = { needed: false, author: 'ai', reason: '暂不影响当前讨论。' }; },
    item => { item.author = 'host'; },
    item => { item.manualFields = ['question']; },
    item => { item.manualFields = ['priority']; },
    item => { item.priority.author = 'host'; },
    item => { item.priority.manualFields = ['level']; },
    item => { item.resolution = { author: 'host', text: '主持人已经记录。' }; },
    item => { item.clarification = { author: 'host', explanation: '主持人的解释。' }; },
    item => { item.stale = true; },
  ]) {
    const meeting = seed(rank('low'));
    protect(meeting.followups[0]);
    const updated = update(meeting);
    assert.deepEqual(updated.followups[0], meeting.followups[0]);
  }
});

test('an unsafe rewording does not block an independently grounded ranking update', () => {
  const meeting = seed();
  const item = meeting.followups[0];
  item.resolution = { author: 'ai', complete: false, text: '只明确了栏目固定。', evidence: [{ ...refs(b)[0], revision: 1 }], sourceRevision: 3 };
  const updated = update(meeting, rank(), { question: '栏目和内容都不能更新，对吗？', rationale: '改成了错误的前提。', impact: '影响所有更新。' });
  assert.equal(updated.followups[0].question, item.question);
  assert.deepEqual(updated.followups[0].resolution, item.resolution);
  assert.equal(updated.followups[0].priority.level, 'high');
  assert.equal(updated.followups[0].history, undefined);
});

test('a source-grounded clarification can restore eligibility and refresh priority in the same analysis', () => {
  for (const prepare of [
    item => { item.attention = { needed: false, author: 'ai', sourceRevision: 3, evidence: [{ ...refs(a)[0], revision: 1 }] }; },
    item => { item.stale = true; item.priority.stale = true; },
  ]) {
    const meeting = seed(rank('low'));
    prepare(meeting.followups[0]);
    const updated = update(meeting, rank('high'), { evidence: refs(b), clarification: { explanation: '栏目保持不变与内容可以更新能同时成立，接口需要区分它们。', evidence: refs(b) } });
    assert.equal(updated.followups[0].stale, false);
    assert.notEqual(updated.followups[0].attention?.needed, false);
    assert.equal(updated.followups[0].priority.level, 'high');
    assert.equal(updated.followups[0].priority.stale, false);
    assert.equal(updated.followups[0].priority.sourceRevision, 4);
  }
});

test('ranking reasons ground participant references and update display after renaming', () => {
  const meeting = seed(rank('high', '[[person:p1]]提出的接口影响需要先说清；[[person:p2]]需要另找发言依据。'));
  const item = meeting.followups[0];
  assert.match(item.priority.reason, /^\[\[person:p1\]\]/);
  assert.match(item.priority.reason, /某位参会者需要另找发言依据/);
  meeting.participants[0].name = '陈先生';
  assert.match(presentMeetingPeople(meeting).followups[0].priority.reason, /^陈先生/);
  assert.equal(peopleReviewRecords(meeting, lines, ['a'], 'labels').some(record => record.path.at(-1) === 'priority'), false);
  const legacy = seed(rank('medium', '陈明提出的接口影响需要先说清。'));
  assert.equal(legacy.followups[0].priority.peopleFields.reason, 0);
  const record = peopleReviewRecords(legacy, lines, ['a'], 'labels').find(record => record.path.at(-1) === 'priority');
  assert.deepEqual(record.evidenceIds, ['a']);
  assert.equal(peopleRecordTarget(legacy, record.path), legacy.followups[0].priority);
});

test('known context carries current rank without nested citation/history payloads', () => {
  const meeting = seed(rank());
  meeting.followups[0].priority.history = [{ reason: '旧排序。' }];
  const context = knownContext(meeting, lines).existingFollowups[0].priority;
  assert.equal(context.level, 'high');
  assert.equal(context.reason, rank().reason);
  assert.deepEqual(context.evidenceIds, ['a']);
  assert.equal(context.evidence, undefined);
  assert.equal(context.history, undefined);
  assert.equal(context.peopleFields, undefined);
});

test('organization rejects a malformed priority visibly instead of advancing analysis', async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-priority-validation-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [], followups: [question({ priority: rank('urgent'), evidence: [{ id: data.sources[0].id, quote: data.sources[0].text }] })] }) } }] }), { status: 200 });
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  const meeting = store.createMeeting({ title: '优先级格式测试' });
  store.appendTranscript(meeting.id, { text: a.text });
  const job = ai.submit(meeting.id, 'organize');
  const until = Date.now() + 5000;
  while (!['done', 'error', 'cancelled'].includes(store.getJob(job.id).status) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 3));
  assert.equal(store.getJob(job.id).status, 'error');
  assert.match(store.getJob(job.id).error, /格式无效/);
  assert.equal(store.getMeeting(meeting.id).processedRevision, 0);
  assert.deepEqual(store.getMeeting(meeting.id).followups, []);
});
