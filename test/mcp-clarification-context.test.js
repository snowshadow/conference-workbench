import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkbench } from '../server/app.js';

test('MCP returns current nested clarification content and citations without historical bodies', async t => {
  const workbench = createWorkbench({ dataDir: mkdtempSync(path.join(tmpdir(), 'meeting-mcp-explanations-')) });
  workbench.server.listen(0, '127.0.0.1');
  await once(workbench.server, 'listening');
  const base = `http://127.0.0.1:${workbench.server.address().port}`;
  const meeting = workbench.store.createMeeting({ title: '解释回读' });
  const sources = ['栏目范围固定', '具体画像可以更新', '本次不改变栏目范围'].map(text => workbench.store.appendTranscript(meeting.id, { text }));
  const ref = index => ({ id: sources[index].id, quote: sources[index].text, revision: 1 });
  const old = [{ text: '旧姓名与旧解释不应进入当前上下文' }];
  const explanation = {
    explanation: '栏目范围和用户内容是两件事。', evidence: [ref(0)], evidenceIds: sources.slice(0, 2).map(item => item.id), author: 'ai', stale: false, history: old,
    distinctions: [{ id: 'meaning', title: '用户内容', text: '每个人的画像可以更新。', example: '偏好随新发言变化。', evidence: [ref(1)], evidenceIds: [sources[1].id], author: 'ai', stale: false, history: old }],
  };
  workbench.store.mutateMeeting(meeting.id, current => {
    current.focusFollowupId = 'active';
    current.followups = [
      { id: 'active', status: 'active', author: 'ai', question: '画像的哪部分固定？', evidenceIds: sources.slice(0, 2).map(item => item.id), clarification: structuredClone(explanation), priority: { level: 'high', reason: '会影响当前更新范围。', evidence: [ref(0)], evidenceIds: [sources[0].id], author: 'ai', history: old }, history: old },
      { id: 'retired', status: 'active', author: 'ai', question: '栏目会不会变？', evidenceIds: sources.map(item => item.id), clarification: structuredClone(explanation), history: old,
        attention: { needed: false, reason: '本次范围不涉及栏目变化。', evidence: [ref(2)], evidenceIds: [sources[2].id], author: 'ai', stale: false, history: old },
        resolution: { text: '用户内容可以变化，更新规则仍需讨论。', outcome: 'clarified', complete: false, evidence: [ref(1)], evidenceIds: [sources[1].id], author: 'ai', stale: false, history: old } },
    ];
  });
  const before = workbench.store.getMeeting(meeting.id);
  const client = new Client({ name: 'clarification-context-test', version: '1.0' });
  t.after(async () => { await client.close(); await workbench.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/server.mjs')], env: { ...process.env, WORKBENCH_URL: base }, stderr: 'pipe' }));
  const result = await client.callTool({ name: 'get_meeting_context', arguments: { meetingId: meeting.id } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const context = JSON.parse(result.content[0].text);
  assert.equal(context.focusFollowupId, 'active');
  assert.equal(context.followups.length, 2);
  assert.equal(context.followups[0].priority.level, 'high');
  assert.equal(context.followups[0].priority.reason, '会影响当前更新范围。');
  assert.deepEqual(context.followups[0].priority.evidence, [ref(0)]);
  assert.doesNotMatch(JSON.stringify(context.followups), /"history"|旧姓名与旧解释/);
  for (const item of context.followups) {
    assert.equal(item.clarification.explanation, explanation.explanation);
    assert.deepEqual(item.clarification.evidence, explanation.evidence);
    assert.equal(item.clarification.distinctions[0].id, 'meaning');
    assert.equal(item.clarification.distinctions[0].example, explanation.distinctions[0].example);
    assert.deepEqual(item.clarification.distinctions[0].evidence, [ref(1)]);
    assert.equal(item.clarification.author, 'ai');
    assert.equal(item.clarification.stale, false);
  }
  assert.deepEqual(context.followups[1].evidenceIds, sources.map(item => item.id));
  assert.equal(context.followups[1].status, 'active');
  assert.equal(context.followups[1].attention.needed, false);
  assert.deepEqual(context.followups[1].attention.evidence, [ref(2)]);
  assert.equal(context.followups[1].resolution.complete, false);
  assert.deepEqual(context.followups[1].resolution.evidence, [ref(1)]);
  assert.deepEqual(workbench.store.getMeeting(meeting.id).followups, before.followups, 'context reads must not mutate stored history');
});
