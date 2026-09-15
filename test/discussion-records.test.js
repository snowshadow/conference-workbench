import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../server/store.js';
import { editFollowup } from '../server/content.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { createAIService } from '../server/ai/service.js';
import { createWorkbench } from '../server/app.js';
import { readingFocusId } from '../shared/discussion-view.js';

function fixture(t, responder = () => ({ topics: [], followups: [] })) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'discussion-records-test-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (url, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content);
    calls.push(data);
    return Response.json({ choices: [{ message: { content: JSON.stringify(await responder(data, store)) } }] });
  } });
  ai.start();
  t.after(async () => { await ai.stop(); store.close(); });
  const meeting = store.createMeeting({ title: '中性讨论记录' });
  const line = store.appendTranscript(meeting.id, { text: '我们决定先做小范围试验，响应时延还需要测量。', speakerId: '1' });
  store.mutateMeeting(meeting.id, current => {
    current.followups = reduceOrganization(current, { followups: [{
      kind: 'assumption', question: '响应时延是否已经测量，能否满足小范围试验的要求？',
      rationale: '目前没有测量结果。', impact: '影响试验范围。',
      shortQuestion: '试验需要多快的响应？', discussionValue: '先核对时延要求，再确定试验范围。',
      evidence: [{ id: line.id, quote: line.text }],
    }] }, [line]).followups;
  });
  return { store, ai, calls, meeting, line, followup: store.getMeeting(meeting.id).followups[0] };
}

async function finish(store, job) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const current = store.getJob(job.id);
    if (['done', 'error', 'cancelled'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('AI fixture did not finish');
}

function record(fixture, extra = {}) {
  const { store, meeting, followup, line } = fixture;
  return editFollowup(store, meeting.id, followup.id, {
    status: 'recorded', sourceRevision: 1, transcriptEditRevision: 0,
    resolution: { outcome: 'recorded', text: '先把告警场景记下来，具体时延还没说清。', evidenceIds: [line.id] }, ...extra,
  });
}

test('saving a note advances focus while keeping the record unresolved and independently editable', t => {
  const f = fixture(t);
  f.store.mutateMeeting(f.meeting.id, meeting => {
    meeting.focusFollowupId = f.followup.id;
    meeting.followups.push({ id: 'next', status: 'active', question: '下一项验收标准是什么？' });
  });
  const before = f.store.allTranscript(f.meeting.id);
  const updated = record(f);
  assert.equal(updated.focusFollowupId, 'next');
  assert.equal(readingFocusId(updated, f.followup.id, true, true), f.followup.id, 'the open editor keeps its reading position');
  assert.equal(readingFocusId(updated, f.followup.id, true, false), 'next', 'closing the editor resumes the next question');
  assert.equal(updated.followups[0].status, 'recorded');
  assert.equal(updated.followups[0].resolution.outcome, 'recorded');
  assert.equal(updated.followups[0].resolution.complete, undefined);
  assert.deepEqual(f.store.allTranscript(f.meeting.id), before);
  f.store.mutateMeeting(f.meeting.id, meeting => { meeting.focusFollowupId = null; });
  assert.equal(record(f).focusFollowupId, null, 'editing a saved record leaves the current focus alone');
  f.store.mutateMeeting(f.meeting.id, meeting => { meeting.focusFollowupId = 'next'; });
  const last = editFollowup(f.store, f.meeting.id, 'next', { status: 'recorded', resolution: { outcome: 'recorded', text: '验收标准仍需补充。' } });
  assert.equal(last.focusFollowupId, null);
});

test('recording a different question does not interrupt the current focus', t => {
  const f = fixture(t);
  f.store.mutateMeeting(f.meeting.id, meeting => {
    meeting.focusFollowupId = 'current';
    meeting.followups.push({ id: 'current', status: 'active', question: '当前正在讨论的问题？' });
  });
  assert.equal(record(f).focusFollowupId, 'current');
});

test('a brief note is recorded without resolving the question, changing transcript facts or losing previous outcomes', t => {
  const f = fixture(t), before = f.store.allTranscript(f.meeting.id);
  record(f);
  let current = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(current.status, 'recorded');
  assert.equal(current.resolution.outcome, 'recorded');
  assert.equal(current.resolution.author, 'host');
  assert.deepEqual(current.resolution.evidence, [{ id: f.line.id, quote: f.line.text, revision: 1 }]);
  assert.deepEqual(current.manualFields, ['status', 'resolution']);
  assert.deepEqual(f.store.allTranscript(f.meeting.id), before);
  assert.deepEqual(f.store.getMeeting(f.meeting.id).topics, []);
  assert.throws(() => editFollowup(f.store, f.meeting.id, f.followup.id, { status: 'resolved' }), /明确结果/);
  assert.throws(() => record(f, { status: 'resolved' }), /recorded/);
  assert.throws(() => record(f, { resolution: undefined }), /讨论记录/);
  editFollowup(f.store, f.meeting.id, f.followup.id, { status: 'resolved', resolution: { outcome: 'needs_verification', text: '后台告警的时延待验证。' } });
  current = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(current.resolution.outcome, 'needs_verification');
  assert.equal(current.history.at(-1).resolution.outcome, 'recorded');
  record(f);
  assert.equal(f.store.getMeeting(f.meeting.id).followups[0].history.at(-1).resolution.outcome, 'needs_verification');
});

test('neutral records tolerate appended speech, reject stale and foreign evidence, and remain auditable after corrections', t => {
  const f = fixture(t), other = f.store.createMeeting({ title: '另一场会议' });
  const foreign = f.store.appendTranscript(other.id, { text: '异场依据。' });
  assert.throws(() => record(f, { resolution: { outcome: 'recorded', text: '记录', evidenceIds: [foreign.id] } }), /本次会议/);
  f.store.appendTranscript(f.meeting.id, { text: '接下来讨论预算。' });
  record(f);
  let current = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(current.sourceRevision, 1);
  assert.equal(current.pendingReview, true);
  f.store.editTranscript(f.meeting.id, f.line.id, { text: '响应时延暂不测量。' });
  current = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(current.status, 'recorded');
  assert.equal(current.stale, true);
  assert.equal(current.resolution.stale, true);
  assert.equal(current.resolution.evidence[0].quote, f.line.text);
  assert.throws(() => record(f), error => error.status === 409);
});

test('late AI organization retries from the manual note and cannot overwrite its status, text or presentation', async t => {
  let f;
  f = fixture(t, data => {
    if (f.calls.length === 1) record(f);
    const source = data.sources[0], item = data.existingFollowups[0];
    return { topics: [], followups: [{ id: item.id, shortQuestion: '已确认时延达标？', evidence: [{ id: source.id, quote: source.text }] }],
      resolvedFollowups: [{ id: item.id, resolution: { outcome: 'clarified', complete: true, text: '时延已确认达标。' }, evidence: [{ id: source.id, quote: source.text }] }] };
  });
  const result = await finish(f.store, f.ai.submit(f.meeting.id, 'organize'));
  assert.equal(result.status, 'done', result.error);
  assert.equal(f.calls.length, 2, 'a content edit invalidates the old task snapshot');
  assert.equal(f.calls[1].existingFollowups[0].status, 'recorded');
  assert.equal(f.calls[1].existingFollowups[0].shortQuestion, f.followup.shortQuestion);
  const current = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(current.status, 'recorded');
  assert.equal(current.resolution.text, '先把告警场景记下来，具体时延还没说清。');
  assert.equal(current.shortQuestion, f.followup.shortQuestion);
});

test('minutes keep neutral notes in discussion records and never use them as decisions or resolved assumptions', async t => {
  const f = fixture(t);
  record(f);
  f.store.mutateMeeting(f.meeting.id, current => {
    current.processedRevision = current.transcriptRevision;
    current.topics = [{ id: 'trial', title: '试验范围', entries: [{ id: 'decision', type: 'decision', status: 'active', text: '先做小范围试验。', evidenceIds: [f.line.id] }] }];
    current.followups[0].topicId = 'trial';
  });
  const result = await finish(f.store, f.ai.submit(f.meeting.id, 'minutes'));
  assert.equal(result.status, 'done', result.error);
  const markdown = result.result.markdown;
  const notes = markdown.split('## 讨论记录\n')[1].split('\n## ')[0];
  assert.match(notes, /主持人记录；未标记为已解决/);
  assert.match(notes, /先把告警场景记下来/);
  assert.match(notes, /#transcript:/);
  assert.doesNotMatch(markdown.split('## 讨论记录\n')[0], /先把告警场景记下来|相关前提/);
  assert.doesNotMatch(markdown.split('## 已经说清楚\n')[1], /先把告警场景记下来/);
  assert.match(markdown.split('## 尚待澄清\n')[1], /响应时延是否已经测量/);
  assert.match(markdown.split('## 尚待澄清\n')[1], /已有讨论记录，问题仍待澄清/);
  assert.equal(f.calls.length, 0, 'the test uses existing organization without a provider request');
});

test('presentation edits preserve full reasoning, source history and status; AI updates do not consume a new-question slot', t => {
  const f = fixture(t), original = f.followup;
  const incoming = { id: original.id, shortQuestion: '告警需要多快？', discussionValue: '时延要求影响试验范围。', evidence: [{ id: f.line.id, quote: f.line.text }] };
  let next = reduceOrganization(f.store.getMeeting(f.meeting.id), { followups: [incoming] }, [f.line], { followupLimit: 0, sourceRevision: 1 });
  assert.equal(next.followups.length, 1);
  assert.equal(next.followups[0].shortQuestion, incoming.shortQuestion);
  for (const key of ['question', 'rationale', 'impact', 'evidence', 'sourceRevision', 'status']) assert.deepEqual(next.followups[0][key], original[key]);
  f.store.saveArtifact(f.meeting.id, 'minutes', { title: '既有纪要', markdown: '原纪要', sourceRevision: 1, author: 'ai' });
  const artifact = f.store.getMeeting(f.meeting.id).artifacts[0];
  editFollowup(f.store, f.meeting.id, original.id, { shortQuestion: '试验中的告警需多快？', sourceRevision: 1, transcriptEditRevision: 0, author: 'agent' });
  const manual = f.store.getMeeting(f.meeting.id).followups[0];
  assert.equal(manual.status, 'active');
  assert.equal(manual.question, original.question);
  assert.equal(manual.resolution, undefined);
  assert.deepEqual(manual.manualFields, ['shortQuestion']);
  assert.equal(manual.history.at(-1).shortQuestion, original.shortQuestion);
  assert.deepEqual(f.store.getMeeting(f.meeting.id).artifacts[0], artifact, 'presentation-only edits leave existing minutes and staleness metadata intact');
  next = reduceOrganization(f.store.getMeeting(f.meeting.id), { followups: [incoming] }, [f.line], { followupLimit: 0 });
  assert.equal(next.followups[0].shortQuestion, manual.shortQuestion);
  assert.equal(next.followups[0].discussionValue, incoming.discussionValue);
  assert.throws(() => editFollowup(f.store, f.meeting.id, original.id, { shortQuestion: [] }), /简短问题/);
  assert.throws(() => editFollowup(f.store, f.meeting.id, original.id, { shortQuestion: 'a'.repeat(201) }), /简短问题/);
  const forged = reduceOrganization(f.store.getMeeting(f.meeting.id), { followups: [{ ...incoming, discussionValue: '错误说明', evidence: [{ id: 'foreign', quote: f.line.text }] }] }, [f.line]);
  assert.equal(forged.followups[0].discussionValue, original.discussionValue);
  const overlong = reduceOrganization(f.store.getMeeting(f.meeting.id), { followups: [{ ...incoming, discussionValue: `${'条件'.repeat(401)}，还是采用另一个方案？` }] }, [f.line]);
  assert.equal(overlong.followups[0].discussionValue, original.discussionValue, 'an overlong summary is ignored instead of cropping away an alternative');
  const blank = { ...f.store.getMeeting(f.meeting.id), followups: [] };
  const created = reduceOrganization(blank, { followups: [{ ...original, id: undefined, shortQuestion: `${'条件'.repeat(101)}，还是其他方案？` }] }, [f.line]);
  assert.equal(created.followups[0].shortQuestion, undefined);
  assert.equal(created.followups[0].question, original.question);
});

test('MCP defaults to a neutral record and exposes presentation, provenance and note without appending speech', async t => {
  const workbench = createWorkbench({ dataDir: mkdtempSync(join(tmpdir(), 'discussion-records-api-')) });
  workbench.server.listen(0, '127.0.0.1');
  await once(workbench.server, 'listening');
  const client = new Client({ name: 'neutral-records-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('mcp/server.mjs')], env: { ...process.env, WORKBENCH_URL: `http://127.0.0.1:${workbench.server.address().port}` }, stderr: 'pipe' }));
  t.after(async () => { await client.close(); await workbench.close(); });
  async function call(name, args) { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
  const meeting = workbench.store.createMeeting({ title: 'Agent 简短记录' });
  const source = workbench.store.appendTranscript(meeting.id, { text: '告警具体时延还需核对。' });
  workbench.store.mutateMeeting(meeting.id, current => { current.followups = [{ id: 'f', status: 'active', author: 'ai', question: '告警时延要求是什么？', rationale: '尚未核对', impact: '影响告警实现', evidenceIds: [source.id] }]; });
  await call('update_followup_presentation', { meetingId: meeting.id, followupId: 'f', shortQuestion: '告警需多快？', discussionValue: '核对时延后再决定实现。', sourceRevision: 1, transcriptEditRevision: 0 });
  await call('record_clarification', { meetingId: meeting.id, followupId: 'f', text: '先记下告警场景。', evidenceIds: [source.id], sourceRevision: 1, transcriptEditRevision: 0 });
  const context = await call('get_meeting_context', { meetingId: meeting.id });
  assert.equal(context.followups[0].status, 'recorded');
  assert.equal(context.followups[0].resolution.outcome, 'recorded');
  assert.equal(context.followups[0].resolution.author, 'agent');
  assert.equal(context.followups[0].shortQuestion, '告警需多快？');
  assert.equal(context.followups[0].question, '告警时延要求是什么？');
  assert.equal(context.followups[0].resolution.text, '先记下告警场景。');
  assert.equal(context.followups[0].history, undefined);
  assert.equal((await call('get_transcript_chunk', { meetingId: meeting.id })).total, 1);
});


test('writes to a merged clarification reject the old ID and identify the surviving question', t => {
  const f = fixture(t), targetId = 'surviving-question';
  f.store.mutateMeeting(f.meeting.id, current => {
    current.followups.push({ ...structuredClone(current.followups[0]), id: targetId, question: '试验的响应时延上限怎么定？' });
    current.followups = reduceOrganization(current, { mergedFollowups: [{ sourceId: f.followup.id, targetId }] }, [f.line]).followups;
  });
  const before = f.store.getMeeting(f.meeting.id);
  assert.equal(before.followups[0].mergedInto, targetId);
  for (const patch of [
    { status: 'recorded', resolution: { outcome: 'recorded', text: '这是旧页面提交的讨论记录。', evidenceIds: [f.line.id] } },
    { status: 'resolved' },
    { status: 'ignored' },
    { shortQuestion: '旧问题的新简写？' },
  ]) {
    assert.throws(() => editFollowup(f.store, f.meeting.id, f.followup.id, { ...patch, author: 'agent' }), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /已合并/);
      assert.ok(error.message.includes(targetId), 'the caller can re-read the surviving question before retrying');
      return true;
    });
    assert.deepEqual(f.store.getMeeting(f.meeting.id), before, 'neither the hidden source nor the surviving question is silently edited');
  }
  editFollowup(f.store, f.meeting.id, targetId, { status: 'recorded', author: 'agent', resolution: { outcome: 'recorded', text: '回读保留问题后补充的记录。', evidenceIds: [f.line.id] } });
  const visible = f.store.getMeeting(f.meeting.id).followups.filter(item => !item.mergedInto);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].resolution.text, '回读保留问题后补充的记录。');
});
