import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceOrganization } from '../server/ai/reducer.js';

const meeting = () => ({ id: 'm', transcriptRevision: 3, topics: [], followups: [] });
const source = (id, text, startMs = 0) => ({ id, meetingId: 'm', text, origin: 'asr', revision: 1, startMs });
const evidence = line => [{ id: line.id, quote: line.text }];
const entry = (id, line, extra = {}) => ({ id, type: 'viewpoint', text: line.text, status: 'active', evidence: evidence(line), ...extra });
const question = (id, line, extra = {}) => ({ id, question: '结果为空还是选错？', rationale: '两者会影响排查方向。', impact: '决定先查阈值还是排序。', kind: 'concept', evidence: evidence(line), ...extra });
const organize = (current, payload, lines, sourceRevision = 3) => reduceOrganization(current, payload, lines, { sourceRevision, followupLimit: 3 });

test('incremental entries leave a summary intact; explicit replacement keeps a cited previous version', () => {
  const a = source('s1', '首版仅支持查询，暂不支持写入。'), b = source('s2', '写入要等权限核对之后。', 1000);
  let current = organize(meeting(), { topics: [{ id: 'new_t', title: '首版范围', summary: a.text, entries: [entry('new_e', a)] }] }, [a], 1);
  const id = current.topics[0].id;
  current = organize(current, { topics: [{ id, title: '首版范围', entries: [entry('new_detail', b)] }] }, [b], 2);
  assert.equal(current.topics[0].summary, a.text);
  assert.equal(current.topics[0].sourceRevision, 1);
  assert.deepEqual(current.topics[0].summaryEvidenceIds, ['s1']);
  const text = '首版仅查询；写入需先核对权限。';
  current = organize(current, { topics: [{ id, title: '首版范围', summary: text, summaryEvidence: [...evidence(a), ...evidence(b)] }] }, [a, b]);
  assert.equal(current.topics[0].summary, text);
  assert.deepEqual(current.topics[0].summaryEvidenceIds, ['s1', 's2']);
  assert.equal(current.topics[0].history[0].summary, a.text);
  assert.deepEqual(current.topics[0].history[0].evidenceIds, ['s1']);
  assert.equal(current.topics[0].history[0].sourceRevision, 1);
  assert.ok(current.topics[0].history[0].changedAt);
  for (const summary of ['', '   ']) {
    const next = organize(current, { topics: [{ id, title: '首版范围', summary, entries: [entry('new_e', b)] }] }, [b]);
    assert.equal(next.topics[0].summary, text);
  }
  const late = organize(current, { topics: [{ id, title: '首版范围', summary: a.text, summaryEvidence: evidence(a) }] }, [a], 1);
  assert.equal(late.topics[0].summary, text);
});

test('summary-only updates require valid evidence and cannot overwrite a host summary', () => {
  const a = source('s1', '现场仅确认试点范围。');
  let current = organize(meeting(), { topics: [{ id: 'new_t', title: '试点', summary: a.text, entries: [entry('new_e', a)] }] }, [a]);
  const id = current.topics[0].id;
  const invalid = organize(current, { topics: [{ id, title: '试点', summary: '全量上线', summaryEvidence: [{ id: 'foreign', quote: a.text }] }] }, [a]);
  assert.equal(invalid.topics[0].summary, a.text);
  current.topics[0].manualFields = ['summary'];
  const manual = organize(current, { topics: [{ id, title: '试点', summary: '已上线', entries: [entry('new_e2', a)] }] }, [a]);
  assert.equal(manual.topics[0].summary, a.text);
});

test('one evolving item can replace fragmented viewpoints and questions while preserving their source history', () => {
  const a = source('s1', '协议目录还没有确定。'), b = source('s2', '协议放 contracts，公共代码放 libs。', 1000);
  let current = organize(meeting(), { topics: [{ id: 'new_t', title: '协议目录', entries: [entry('new_e1', a), entry('new_e2', a, { type: 'question', text: '协议放哪？', status: 'open' })] }] }, [a], 1);
  const topic = current.topics[0], [first, second] = topic.entries;
  current = organize(current, { topics: [{ id: topic.id, title: topic.title, entries: [entry(first.id, b, { supersedes: [second.id] })] }] }, [a, b]);
  assert.equal(current.topics[0].entries.length, 2);
  assert.equal(current.topics[0].entries.filter(e => e.status !== 'superseded').length, 1);
  assert.equal(current.topics[0].entries[0].history[0].text, a.text);
  assert.deepEqual(current.topics[0].entries[0].history[0].evidenceIds, ['s1']);
  assert.equal(current.topics[0].entries[1].supersededBy, first.id);
  assert.equal(current.topics[0].entries[1].history[0].text, '协议放哪？');
});

test('viewpoint consolidation cannot retract decisions, actions or authored items', () => {
  const a = source('s1', '我们决定采用 A。'), b = source('s2', '只是补充一个实现细节。', 1000);
  let current = organize(meeting(), { topics: [{ id: 'new_t', title: '方案', entries: [entry('new_d', a, { type: 'decision', explicitDecision: true }), entry('new_a', a, { type: 'action', text: '检查 A。' }), entry('new_host', a, { text: '主持人核对 A。' }), entry('new_agent', a, { text: 'Agent 记录 A。' })] }] }, [a]);
  const topic = current.topics[0];
  topic.entries[2].manualFields = ['text']; topic.entries[3].author = 'agent';
  const ids = topic.entries.map(e => e.id);
  current = organize(current, { topics: [{ id: topic.id, title: topic.title, entries: [entry(ids[0], b), entry('new_view', b, { supersedes: ids })] }] }, [a, b]);
  assert.equal(current.topics[0].entries[0].type, 'decision');
  assert.ok(current.topics[0].entries.slice(0, 4).every(e => e.status === 'active'));
});

test('an active question evolves in place without consuming a new-question slot, keeping its stronger sources', () => {
  const a = source('s1', '是召回错了还是结果为空？'), b = source('s2', '不是选错，是阈值把结果滤空了，还要确认阈值。', 1000);
  let current = organize(meeting(), { followups: [question('new_q', a, { shortQuestion: '是否选错？' })], focusFollowupId: 'new_q' }, [a], 1);
  const id = current.followups[0].id;
  const incoming = question(id, b, { question: '阈值按什么条件确定？', rationale: '已澄清为空召回，阈值仍待确定。' });
  current = reduceOrganization(current, { followups: [incoming], focusFollowupId: id }, [a, b], { sourceRevision: 2, followupLimit: 0 });
  assert.equal(current.followups.length, 1);
  assert.equal(current.followups[0].id, id);
  assert.equal(current.followups[0].question, incoming.question);
  assert.equal(current.followups[0].shortQuestion, undefined, 'old abbreviated question must not mask the new one');
  assert.deepEqual(current.followups[0].evidenceIds, ['s2']);
  assert.equal(current.followups[0].history[0].question, '结果为空还是选错？');
  const regressed = organize(current, { followups: [question(id, a)] }, [a, b]);
  assert.equal(regressed.followups[0].question, incoming.question);
  assert.deepEqual(regressed.followups[0].evidenceIds, ['s2']);
});

test('partial progress stays active; a later complete answer exits focus, and old trigger evidence cannot undo it', () => {
  const a = source('s1', '实时是立即推送，还是刷新时可见？'), b = source('s2', '这里先按刷新理解，具体刷新周期还要定。', 1000), c = source('s3', '刷新周期就定为十秒，双方都按这个执行。', 2000);
  let current = organize(meeting(), { followups: [question('new_q', a)], focusFollowupId: 'new_q' }, [a], 1);
  const id = current.followups[0].id;
  current = organize(current, { resolvedFollowups: [{ id, resolution: { outcome: 'clarified', text: b.text, complete: false }, evidence: evidence(b) }], focusFollowupId: id }, [a, b], 2);
  assert.equal(current.followups[0].status, 'active');
  assert.equal(current.followups[0].resolution.complete, false);
  assert.equal(current.focusFollowupId, id);
  const regression = organize(current, { resolvedFollowups: [{ id, resolution: { outcome: 'clarified', text: '双方已完全对齐。', complete: true }, evidence: evidence(a) }] }, [a, b]);
  assert.equal(regression.followups[0].resolution.complete, false);
  current = organize(current, { resolvedFollowups: [{ id, resolution: { outcome: 'clarified', text: c.text, complete: true }, evidence: evidence(c) }], focusFollowupId: id }, [a, b, c]);
  assert.equal(current.followups[0].status, 'resolved');
  assert.equal(current.focusFollowupId, null);
  assert.equal(current.followups[0].history[0].resolution.text, b.text);
  const repeated = organize(current, { followups: [question('new_repeat', a)], focusFollowupId: 'new_repeat' }, [a, b, c]);
  assert.equal(repeated.followups.length, 1);
  assert.equal(repeated.focusFollowupId, null);
});

test('duplicate active questions merge with retained evidence and focus follows the surviving ID', () => {
  const a = source('s1', '实时周期未确定。'), b = source('s2', '显示延时要先对齐。', 1000);
  let current = organize(meeting(), { followups: [question('new_a', a), question('new_b', b, { question: '刷新等待多久才可接受？' })] }, [a, b], 1);
  assert.equal(current.followups.length, 2);
  const [first, second] = current.followups;
  current = organize(current, { mergedFollowups: [{ sourceId: first.id, targetId: second.id }], focusFollowupId: first.id }, [a, b]);
  assert.equal(current.followups[0].status, 'merged');
  assert.equal(current.followups[0].mergedInto, second.id);
  assert.deepEqual(new Set(current.followups[1].evidenceIds), new Set(['s1', 's2']));
  assert.equal(current.followups[0].history[0].status, 'active');
  assert.equal(current.focusFollowupId, second.id);
  assert.equal(organize(current, { focusFollowupId: null }, [a, b]).focusFollowupId, null);
  assert.equal(organize(current, { focusFollowupId: 'foreign' }, [a, b]).focusFollowupId, null);
});

test('AI leaves host and Agent discussion records intact across evolution, merge and completion', () => {
  const a = source('s1', '需要继续核对。'), b = source('s2', '新说明。', 1000);
  let current = organize(meeting(), { followups: [question('new_a', a), question('new_b', b, { question: '交付什么时候完成？' })] }, [a, b]);
  const [first, second] = current.followups;
  first.resolution = { author: 'agent', text: '暂按试点范围理解。', complete: false }; first.manualFields = ['resolution'];
  const before = structuredClone(first);
  current = organize(current, { followups: [question(first.id, b, { question: '改掉人工记录？' })], resolvedFollowups: [{ id: first.id, resolution: { outcome: 'clarified', text: b.text, complete: true }, evidence: evidence(b) }], mergedFollowups: [{ sourceId: first.id, targetId: second.id }] }, [a, b]);
  assert.deepEqual(current.followups[0], before);
});

test('merging a partially explained question carries its answer evidence and archived progress into the survivor', () => {
  const a = source('s1', '实时周期未确定。'), b = source('s2', '显示延时要先对齐。', 1000), c = source('s3', '已说明显示包括排队，周期还没定。', 2000);
  let current = organize(meeting(), { followups: [question('new_a', a), question('new_b', b, { question: '刷新等待多久才可接受？' })] }, [a, b], 1);
  const [first, second] = current.followups;
  current = organize(current, { resolvedFollowups: [{ id: first.id, resolution: { outcome: 'clarified', text: c.text, complete: false }, evidence: evidence(c) }] }, [a, b, c], 2);
  current = organize(current, { mergedFollowups: [{ sourceId: first.id, targetId: second.id }] }, [a, b, c]);
  assert.deepEqual(new Set(current.followups[1].evidenceIds), new Set(['s1', 's2', 's3']));
  const merged = current.followups[1].history.find(item => item.mergedFrom === first.id);
  assert.equal(merged.resolution.text, c.text);
  assert.equal(merged.resolution.complete, false);
});
