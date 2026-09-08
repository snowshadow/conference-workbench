import test from 'node:test';
import assert from 'node:assert/strict';
import { knownContext, supplementEvidence, reviewEvidence } from '../server/ai/context.js';

const line = (id, text, startMs) => ({ id, meetingId: 'm', origin: 'asr', revision: 1, text, startMs, endMs: startMs + 5000 });
const meeting = fields => ({ id: 'm', topics: [], followups: [], ...fields });

test('incremental context retains existing summaries and omits superseded process entries', () => {
  const m = meeting({ topics: [{ id: 'topic', title: '接口', summary: '仅验证调用入口，参数不在范围。', summaryEvidenceIds: ['answer'], entries: [
    { id: 'old', text: '参数是否验证？', type: 'question', status: 'superseded' },
    { id: 'current', text: '只验证入口', type: 'viewpoint', status: 'active', evidenceIds: ['answer'] },
  ] }] });
  const context = knownContext(m, []);
  assert.equal(context.knownTopics[0].summary, m.topics[0].summary);
  assert.deepEqual(context.knownTopics[0].summaryEvidenceIds, ['answer']);
  assert.deepEqual(context.knownEntries.map(item => item.id), ['current']);
});

test('old doubts retrieve later answers and short neighbouring confirmations', () => {
  const lines = [line('q', '接口的参数也在本次准确率验证范围内吗？', 0)];
  for (let i = 0; i < 50; i++) lines.push(line(`f${i}`, '设备采购另外安排。', 60000 + i * 10000));
  lines.push(line('a', '本次准确率只验证函数头，参数定义尚未改，参数不在范围。', 800000));
  lines.push(line('yes', '对，就按这个范围。', 805000));
  lines.push(line('tail', '散会。', 1800000));
  const m = meeting({ processedLineCount: lines.length - 1, followups: [{ id: 'f', question: lines[0].text, status: 'active', evidenceIds: ['q'] }] });
  const result = supplementEvidence(m, [lines.at(-1)], lines);
  assert.ok(result.some(item => item.id === 'a'));
  assert.ok(result.some(item => item.id === 'yes'));
  assert.equal(new Set(result.map(item => item.id)).size, result.length);
  assert.ok(result.indexOf(result.find(item => item.id === 'a')) < result.indexOf(result.find(item => item.id === 'yes')));
});

test('supplement keeps older explicit result citations while searching for new progress', () => {
  const lines = [line('q', '生产方是否处理限流？', 0), line('a', '限流在日志服务内部处理。', 5000), line('new', '设备准备好了。', 500000)];
  const m = meeting({ followups: [{ id: 'f', question: lines[0].text, status: 'active', evidenceIds: ['q'], resolution: { text: '限流在服务内', evidenceIds: ['a'], complete: false } }] });
  assert.ok(supplementEvidence(m, [lines[2]], lines).some(item => item.id === 'a'));
});

test('short complete meetings can be reviewed without retrieval gaps', () => {
  const lines = [line('q', '先用接口还是消息队列？', 0), line('a', '两个位置：服务间调接口，服务内部走队列。', 200000)];
  assert.deepEqual(reviewEvidence(meeting(), lines, []), lines);
});

test('merged questions stay out of the model current context', () => {
  const m = meeting({ followups: [{ id: 'old', status: 'active', mergedInto: 'current' }, { id: 'current', status: 'active' }], focusFollowupId: 'current' });
  assert.deepEqual(knownContext(m, []).existingFollowups.map(item => item.id), ['current']);
  assert.equal(knownContext(m, []).focusFollowupId, 'current');
});
