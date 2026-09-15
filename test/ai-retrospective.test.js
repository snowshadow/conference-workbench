import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';
import { retrospectiveCodec, retrospectiveWireData, packRetrospective } from '../server/ai/retrospective.js';
import { resolvePeopleText } from '../shared/people.js';

const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
const empty = () => ({ topics: [], followups: [] });
const cite = source => ({ id: source.id, quote: source.text });
const quoteFrom = (data, evidence) => evidence.quote ?? data.sources?.find(source => source.id === evidence.id)?.text ?? data.quotedSources?.find(source => source.id === evidence.id)?.quotes[0];
const idsOnly = value => Array.isArray(value) ? value.map(idsOnly) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'quote').map(([key, item]) => [key, idsOnly(item)])) : value;
const topic = source => ({ id: 'new_t', title: '画像的两种含义', summary: '栏目结构和栏目值分别讨论。', summaryEvidence: [cite(source)], entries: [{ type: 'viewpoint', text: '栏目和栏目值可以分别更新。', evidence: [cite(source)] }] });
const focus = (source, options = {}) => ({ id: 'new_f', retrospective: true, kind: 'concept', question: '稳定的是栏目，还是栏目值？', rationale: '稳定所指对象不同。', impact: '影响画像更新方法。', evidence: [cite(source)], priority: { level: 'high', reason: '区分对象能解开反复讨论。' }, clarification: { explanation: '栏目结构与栏目内的信息分开理解。', evidence: [cite(source)] }, resolution: { outcome: 'clarified', complete: true, text: '会上最后明确栏目结构和信息分开。', evidence: [cite(source)] }, ...options });

test('wire evidence is shared without losing distinct excerpts, original speech or stored citations', () => {
  const text = '保留原话中的错子、标点和不同条件。'.repeat(100);
  const original = { coveredSections: [{ topics: Array.from({ length: 40 }, () => topic({ id: 's1', text })), followups: [focus({ id: 's2', text: '早期说法' }), focus({ id: 's2', text: '后来的纠正' })] }] };
  const wire = retrospectiveWireData(original);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(original).length / 4);
  assert.deepEqual(wire.quotedSources, [{ id: 's1', quotes: [text] }, { id: 's2', quotes: ['早期说法', '后来的纠正'] }]);
  assert.deepEqual(wire.coveredSections[0].topics[0].summaryEvidence, [{ id: 's1' }]);
  assert.equal(original.coveredSections[0].topics[0].summaryEvidence[0].quote, text);
  assert.deepEqual(retrospectiveWireData(wire), wire);
  const direct = retrospectiveWireData({ sources: [{ id: 's1', text }], evidence: [{ id: 's1', quote: text.slice(0, 30) }] });
  assert.equal(direct.quotedSources, undefined);
  assert.equal(direct.sources[0].text, text);
});

function fixture(t, responder, options = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-retrospective-')));
  store.saveSettings({ llm: { baseUrl: 'http://localhost:1234/v1', model: 'fixture' } });
  const calls = [];
  const ai = createAIService({ store, ...options, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    calls.push(data); return responder(data, { store, calls, body });
  } });
  ai.start(); t.after(async () => { await ai.stop(); store.close(); });
  return { store, ai, calls };
}
function seed(store, text = '最后说清楚了：固定的是栏目结构，栏目里的信息可以更新。') {
  const created = store.createMeeting({ title: '完整录音复盘', autoOrganize: false });
  const meeting = store.updateMeeting(created.id, { source: 'recording_import', status: 'ended' });
  const line = store.appendTranscript(meeting.id, { text, speakerId: 'speaker-1', startMs: 0, endMs: 2000 });
  return { meeting, line };
}
async function finish(store, submitted) {
  for (let i = 0; i < 2000; i++) {
    const job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('Retrospective fixture did not finish');
}

test('imported meetings use full sources twice, preserve resolved reading focuses, and reuse final analysis for minutes', async t => {
  const { store, ai, calls } = fixture(t, data => {
    assert.equal(data.coverage.complete, true);
    assert.equal(data.sources.length, 2);
    assert.equal(data.sources[1].origin, 'host');
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    assert.equal(data.mode, 'retrospective_focus');
    assert.equal(data.knownTopics.length, 1);
    const source = data.sources[0];
    return response({ followups: [focus(source, { topicId: data.knownTopics[0].id, clarification: { explanation: `[[person:${source.participantId}]] 所说的结构和信息可以分开理解。`, evidence: [cite(source)] } }), focus(data.sources[1], { id: 'new_f2', question: '另一件要复盘的关键前提是否已经验证？', resolution: undefined })], focusFollowupId: 'new_f' });
  });
  const { meeting, line } = seed(store);
  store.appendTranscript(meeting.id, { text: '补记：还要验证另一个关键前提。', origin: 'host', startMs: 3000, endMs: 4000 });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(calls.map(item => item.mode), ['retrospective_topics', 'retrospective_focus']);
  let saved = store.getMeeting(meeting.id);
  assert.equal(saved.followups.length, 2);
  const resolved = saved.followups.find(item => item.status === 'resolved');
  assert.equal(resolved.retrospective, true);
  assert.equal(saved.focusFollowupId, resolved.id);
  assert.deepEqual(resolved.resolution.evidenceIds, [line.id]);
  assert.ok(!JSON.stringify(saved.followups).includes('[[person:p1]]'));
  assert.equal(saved.retrospectiveAnalysis.contentRevision, saved.contentRevision);
  assert.equal(saved.retrospectiveAnalysis.focusCompleted, true);
  assert.ok(job.modelCalls.every(call => call.durationMs >= 0 && call.endedAt && call.status === 'done' && call.promptVersion.startsWith('retrospective-')));
  assert.ok(job.stages.every(stage => stage.endedAt && stage.status === 'done'));
  for (let i = 0; i < 2; i++) {
    const minutes = await finish(store, ai.submit(meeting.id, 'minutes'));
    assert.equal(minutes.status, 'done', minutes.error);
  }
  assert.equal(calls.length, 2, 'saving a minutes artifact does not invalidate complete analysis');
  saved = store.getMeeting(meeting.id);
  const markdown = saved.artifacts.find(item => item.type === 'minutes').markdown;
  assert.ok(markdown.includes('会上最后明确'));
  assert.match(markdown, /AI 理解建议（不是会议结论）/);
  assert.match(markdown, /结构和信息可以分开理解/);
  assert.doesNotMatch(markdown, /## 尚待澄清/);
  const person = saved.participants.find(item => item.speakerIds.includes('speaker-1'));
  store.updateParticipant(meeting.id, person.id, { name: '陈同学' });
  assert.match(resolvePeopleText(resolved.clarification.explanation, store.getMeeting(meeting.id)), /陈同学/);
});

test('long imports cover every source before global topics and focus, including final corrections', async t => {
  const budget = 8000;
  const extractedIds = [];
  const { store, ai, calls } = fixture(t, data => {
    assert.ok(JSON.stringify(data).length <= budget);
    if (data.mode === 'retrospective_extract') {
      extractedIds.push(...data.sources.map(source => source.id));
      const first = data.sources[0], last = data.sources.at(-1);
      return response({ topics: [{ ...topic(first), entries: [{ type: 'viewpoint', text: first.text.slice(0, 30), evidence: [{ id: first.id, quote: first.text.slice(0, 30) }] }], summaryEvidence: [{ id: last.id, quote: last.text.slice(0, 30) }] }], followups: [] });
    }
    assert.ok(data.coveredSections.length >= 2);
    assert.equal(data.coverage.material, 'section_summaries');
    assert.equal(data.coverage.complete, true);
    const evidence = data.coveredSections.at(-1).topics[0].summaryEvidence;
    assert.match(quoteFrom(data, evidence[0]), /最后明确/);
    if (data.mode === 'retrospective_synthesis') return response({ topics: [{ ...topic({ id: evidence[0].id, text: quoteFrom(data, evidence[0]) }), id: 'new_all' }], followups: [] });
    return response({ followups: [focus({ id: evidence[0].id, text: quoteFrom(data, evidence[0]) }, { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' });
  }, { retrospectiveMaxChars: budget });
  const { meeting } = seed(store, '最初讨论把栏目和信息混在一起。'.repeat(100));
  for (let i = 0; i < 7; i++) store.appendTranscript(meeting.id, { text: `第${i}段描述会议中的不同说法。`.repeat(90), startMs: 4000 + i * 2000, endMs: 6000 + i * 2000 });
  const last = store.appendTranscript(meeting.id, { text: '最后明确：栏目和栏目里的信息是不同的对象，后者仍可以变化。', startMs: 20000, endMs: 23000 });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(extractedIds, Array.from({ length: 9 }, (_, index) => `s${index + 1}`));
  assert.equal(calls.at(-1).mode, 'retrospective_focus');
  assert.deepEqual(store.getMeeting(meeting.id).followups[0].resolution.evidenceIds, [last.id]);
});

test('focus failure keeps published topics and retries only focus; source correction restarts full review', async t => {
  let failFocus = true;
  const { store, ai, calls } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    if (failFocus) return new Response('{}', { status: 401 });
    return response({ followups: [focus(data.sources[0], { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' });
  });
  const { meeting, line } = seed(store);
  const failed = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(failed.status, 'error');
  const checkpoint = store.getMeeting(meeting.id);
  assert.equal(checkpoint.topics.length, 1);
  assert.equal(checkpoint.retrospectiveAnalysis.focusCompleted, false);
  failFocus = false;
  const retry = await finish(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(retry.status, 'done', retry.error);
  assert.deepEqual(calls.map(item => item.mode), ['retrospective_topics', 'retrospective_focus', 'retrospective_focus']);
  store.editTranscript(meeting.id, line.id, { text: '修正后的原话：栏目固定，信息仍能随情况更新。' });
  const corrected = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(corrected.status, 'done', corrected.error);
  assert.deepEqual(calls.slice(-2).map(item => item.mode), ['retrospective_topics', 'retrospective_focus']);
});

test('invalid evidence fails visibly after topics instead of saving a fabricated retrospective resolution', async t => {
  const { store, ai, calls } = fixture(t, data => data.mode === 'retrospective_topics' ? response({ topics: [topic(data.sources[0])], followups: [] }) : response({ followups: [focus(data.sources[0], { resolution: { outcome: 'clarified', complete: true, text: '大家都同意了', evidence: [{ id: data.sources[0].id, quote: '并不存在的原话' }] } })], focusFollowupId: 'new_f' }));
  const { meeting } = seed(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'error');
  assert.match(job.error, /引用与会议原话不符/);
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.topics.length, 1);
  assert.equal(saved.followups.length, 0);
  assert.equal(saved.retrospectiveAnalysis.focusCompleted, false);
  assert.equal(calls.filter(item => item.mode === 'retrospective_focus').length, 2);
  assert.equal(job.modelCalls.at(-1).formatRetries, 1);
  assert.equal(job.modelCalls.at(-1).status, 'error');
});

test('a corrected quote gets one bounded retry without accepting an ASR spelling correction as verbatim', async t => {
  let attempts = 0;
  const { store, ai, calls } = fixture(t, (data, { body }) => {
    if (data.mode === 'retrospective_topics') {
      attempts++;
      const item = topic(data.sources[0]);
      if (attempts === 1) item.entries[0].evidence[0].quote = item.entries[0].evidence[0].quote.replace('入餐', '入参');
      else assert.match(body.messages[0].content, /保留原文的 ASR 错字/);
      return response({ topics: [item], followups: [] });
    }
    return response({ followups: [focus(data.sources[0], { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' });
  });
  const { meeting, line } = seed(store, '入餐只有一个固定字段，字段值仍可以变化。');
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(calls.map(item => item.mode), ['retrospective_topics', 'retrospective_topics', 'retrospective_focus']);
  assert.equal(job.modelCalls[0].formatRetries, 1);
  assert.equal(job.modelCalls[0].status, 'done');
  assert.equal(store.getMeeting(meeting.id).topics[0].entries[0].evidence[0].quote, line.text);
});

test('compact metadata preserves speech, quotes, shared membership, and origin without accepting unknown people', t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-retrospective-codec-'))); t.after(() => store.close());
  const { meeting, line } = seed(store, '这句原话包含 [[person:p9]]，不能把字面文本替换掉。');
  const member = store.createMember({ name: '林同学' });
  let saved = store.getMeeting(meeting.id);
  store.updateParticipant(meeting.id, saved.participants[0].id, { memberId: member.id, name: '林同学' });
  saved = store.getMeeting(meeting.id);
  const codec = retrospectiveCodec(saved, store.allTranscript(meeting.id));
  assert.equal(codec.sources[0].text, line.text);
  assert.equal(codec.participants[0].memberId, member.id);
  assert.equal(codec.decode({ evidence: [{ id: 's1', quote: line.text }] }).evidence[0].quote, line.text);
  assert.deepEqual(codec.decode({ evidence: [{ id: 's1' }] }).evidence[0], { id: line.id, quote: line.text });
  const personMarker = `[[person:${saved.participants[0].id}]]`;
  const decoded = codec.decode({ explanation: 'p1解释，[[person:p1]]补充。sp1、p1_suffix 是其他标识。', id: 'p1', sourceSpan: { from: 'p1', to: 'p1', count: 1 }, quote: 'p1 和 [[person:p1]] 的字面原话。' });
  assert.equal(decoded.explanation, `${personMarker}解释，${personMarker}补充。sp1、p1_suffix 是其他标识。`);
  assert.equal(decoded.id, 'p1');
  assert.equal(decoded.sourceSpan.from, 'p1');
  assert.equal(decoded.sourceSpan.to, 'p1');
  assert.equal(decoded.quote, 'p1 和 [[person:p1]] 的字面原话。');
  assert.throws(() => codec.decode({ rationale: '[[person:p9]] 表达了不同观点。' }), /未知的参会者/);
  assert.throws(() => codec.decode({ rationale: 'p9 表达了不同观点。' }), /未知的参会者/);
  assert.throws(() => codec.decode({ evidence: [{ id: 's999', quote: line.text }] }), /原话不符/);
  assert.throws(() => codec.decode({ evidence: [{ id: 's999' }] }), /原话不符/);
  const items = [{ text: 'a'.repeat(80) }, { text: 'b'.repeat(80) }];
  const makeData = sources => ({ sources, participants: [{ id: 'p1', displayName: '名字' }] });
  const exact = JSON.stringify(makeData(items)).length;
  assert.equal(packRetrospective(items, makeData, exact).length, 1);
  assert.equal(packRetrospective(items, makeData, exact - 1).length, 2);
});

test('bare compact person labels still require the cited utterance to support their attribution', async t => {
  const { store, ai } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    const supported = data.sources[0], other = data.sources[1];
    return response(idsOnly({ followups: [focus(supported, {
      clarification: { explanation: `${supported.participantId}解释了栏目，${other.participantId}说明了信息。`, evidence: [cite(supported)] },
      resolution: { outcome: 'clarified', complete: true, text: `[[person:${supported.participantId}]]已说明；${other.participantId}也认可。`, evidence: [cite(supported)] },
    })], focusFollowupId: 'new_f' }));
  });
  const { meeting } = seed(store);
  store.appendTranscript(meeting.id, { text: '这位参会者只说了另一件事。', speakerId: 'speaker-2', startMs: 3000, endMs: 4000 });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  const saved = store.getMeeting(meeting.id), result = saved.followups[0];
  const firstPerson = saved.participants.find(item => item.speakerIds.includes('speaker-1'));
  const secondPerson = saved.participants.find(item => item.speakerIds.includes('speaker-2'));
  assert.ok(result.clarification.explanation.includes(`[[person:${firstPerson.id}]]`));
  assert.ok(result.resolution.text.includes(`[[person:${firstPerson.id}]]`));
  assert.ok(!result.clarification.explanation.includes(secondPerson.id));
  assert.ok(!result.resolution.text.includes(secondPerson.id));
  assert.match(result.clarification.explanation, /某位参会者说明了信息/);
  assert.match(result.resolution.text, /某位参会者也认可/);
  assert.doesNotMatch(result.clarification.explanation, /\bp\d+\b/);
});

test('source-ID-only topics and focuses preserve the entire original utterance without model copying or truncation', async t => {
  const { store, ai, calls } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response(idsOnly({ topics: [topic(data.sources[0])], followups: [] }));
    return response(idsOnly({ followups: [focus(data.sources[0], { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' }));
  });
  const text = '先先摸清楚这个入餐，字段固定但是信息可更新。'.repeat(250);
  const { meeting, line } = seed(store, text);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.equal(calls.length, 2);
  assert.ok(job.modelCalls.every(call => !call.formatRetries));
  const saved = store.getMeeting(meeting.id);
  assert.deepEqual(saved.topics[0].summaryEvidenceIds, [line.id]);
  for (const evidence of [saved.topics[0].entries[0].evidence, saved.followups[0].evidence, saved.followups[0].clarification.evidence, saved.followups[0].resolution.evidence]) {
    assert.equal(evidence[0].id, line.id);
    assert.equal(evidence[0].quote, text);
    assert.equal(evidence[0].quote.length, text.length);
  }
});

test('long ID-only extraction exposes system-sourced full quotes to all later synthesis stages', async t => {
  const originals = new Map(), extracted = [];
  const { store, ai, calls } = fixture(t, data => {
    assert.ok(JSON.stringify(data).length <= 5000);
    if (data.mode === 'retrospective_extract') {
      for (const source of data.sources) { originals.set(source.id, source.text); extracted.push(source.id); }
      return response(idsOnly({ topics: [topic(data.sources.at(-1))], followups: [] }));
    }
    assert.equal(data.coverage.complete, true);
    assert.equal(data.coverage.totalSources, 15);
    assert.equal(data.coveredSections.reduce((sum, part) => sum + part.sourceSpan.count, 0), 15);
    for (const part of data.coveredSections) for (const item of part.topics) {
      for (const evidence of [item.summaryEvidence, item.entries[0].evidence]) assert.equal(quoteFrom(data, evidence[0]), originals.get(evidence[0].id));
    }
    const tail = data.coveredSections.at(-1).topics[0].summaryEvidence[0];
    if (data.mode === 'retrospective_synthesis') return response(idsOnly({ topics: [topic({ id: tail.id, text: quoteFrom(data, tail) })], followups: [] }));
    return response(idsOnly({ followups: [focus({ id: tail.id, text: quoteFrom(data, tail) }, { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' }));
  }, { retrospectiveMaxChars: 5000 });
  const { meeting } = seed(store, '第0段谈到固定栏目与变化信息。'.repeat(25));
  for (let i = 1; i < 15; i++) store.appendTranscript(meeting.id, { text: `第${i}段谈到固定栏目与变化信息。`.repeat(25), startMs: i * 2000, endMs: i * 2000 + 1000 });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(extracted, Array.from({ length: 15 }, (_, i) => `s${i + 1}`));
  assert.equal(calls.at(-1).mode, 'retrospective_focus');
  assert.equal(store.getMeeting(meeting.id).followups[0].resolution.evidence[0].quote, originals.get('s15'));
});

test('an unknown ID-only source fails before publishing topics instead of manufacturing a quote', async t => {
  const { store, ai, calls } = fixture(t, data => response(idsOnly({ topics: [topic({ id: 's999', text: data.sources[0].text })], followups: [] })));
  const { meeting } = seed(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'error');
  assert.match(job.error, /原话不符/);
  assert.equal(calls.length, 2);
  assert.equal(store.getMeeting(meeting.id).topics.length, 0);
  assert.equal(store.getMeeting(meeting.id).retrospectiveAnalysis, undefined);
});

test('background recognition progress does not restart analysis, but a real name correction does', async t => {
  let changedName = false;
  const { store, ai, calls } = fixture(t, data => {
    const person = store.getMeeting(data.meetingId).participants[0];
    if (data.mode === 'retrospective_topics') {
      store.setParticipantRecognition(data.meetingId, person.id, { status: 'waiting', attempts: calls.length });
      return response({ topics: [topic(data.sources[0])], followups: [] });
    }
    if (!changedName) {
      changedName = true;
      store.updateParticipant(data.meetingId, person.id, { name: '张同学' });
    }
    return response({ followups: [focus(data.sources[0], { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' });
  });
  const { meeting } = seed(store);
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(calls.map(item => item.mode), ['retrospective_topics', 'retrospective_focus', 'retrospective_topics', 'retrospective_focus']);
  assert.equal(calls[2].participants[0].displayName, '张同学');
});

test('a new full selection retires only old AI reading flags and keeps host revisions and minutes intact', async t => {
  let count = 0;
  const { store, ai } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    count++;
    return response({ followups: count === 1 ? [focus(data.sources[0]), focus(data.sources[0], { id: 'new_other', question: '长期记忆该如何提取长期偏好？', resolution: undefined }), focus(data.sources[0], { id: 'new_host', question: '第三项需要保留主持人的原始判断。', resolution: undefined })] : [], focusFollowupId: count === 1 ? 'new_f' : null });
  });
  const { meeting } = seed(store);
  assert.equal((await finish(store, ai.submit(meeting.id, 'organize'))).status, 'done');
  store.mutateMeeting(meeting.id, m => {
    const item = m.followups.find(f => f.question.startsWith('第三项'));
    item.resolution = { outcome: 'recorded', complete: false, text: '主持人决定另行讨论。', author: 'host', evidenceIds: [] };
    item.status = 'recorded';
    m.topics[0].summary = '主持人修改的最终概述。'; m.topics[0].manualFields = ['summary'];
  });
  const manual = store.saveArtifact(meeting.id, 'minutes', { markdown: '# 主持人的纪要\n\n请原样保留。', author: 'host', sourceRevision: 1 });
  const job = await finish(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(job.status, 'done', job.error);
  let saved = store.getMeeting(meeting.id);
  assert.equal(saved.topics[0].summary, '主持人修改的最终概述。');
  assert.equal(saved.followups.length, 3);
  assert.equal(saved.followups.filter(item => item.retrospective).length, 1);
  assert.equal(saved.followups.find(item => item.retrospective).resolution.text, '主持人决定另行讨论。');
  const minutes = await finish(store, ai.submit(meeting.id, 'minutes'));
  assert.equal(minutes.status, 'done', minutes.error);
  saved = store.getMeeting(meeting.id);
  assert.equal(saved.artifacts.find(item => item.id === manual.id).markdown, manual.markdown);
  const generated = saved.artifacts.find(item => item.type === 'minutes-draft').markdown;
  assert.match(generated, /主持人决定另行讨论/);
  assert.doesNotMatch(generated, /长期记忆该如何提取长期偏好/);
});

test('multi-level synthesis keeps continuous coverage compact and includes every source range', async t => {
  const budget = 5000, seen = [];
  let compressionCalls = 0;
  const { store, ai } = fixture(t, data => {
    assert.ok(JSON.stringify(data).length <= budget);
    if (data.mode === 'retrospective_extract') {
      seen.push(...data.sources.map(line => line.id));
      const source = data.sources.at(-1), evidence = [{ id: source.id, quote: source.text.slice(0, 20) }];
      return response({ topics: [{ id: 'new_chunk', title: '一段讨论', summaryEvidence: evidence, entries: Array.from({ length: 5 }, (_, i) => ({ type: 'viewpoint', text: `事项${i}。${'关于栏目和信息应分别理解。'.repeat(24)}`, evidence })) }], followups: [] });
    }
    assert.ok(data.coveredSections.every(section => section.sourceSpan.count > 0));
    if (!data.coverage.complete) compressionCalls++;
    else {
      assert.equal(data.coveredSections.reduce((sum, section) => sum + section.sourceSpan.count, 0), 18);
      assert.equal(data.coveredSections[0].sourceSpan.from, 's1');
      assert.equal(data.coveredSections.at(-1).sourceSpan.to, 's18');
    }
    const quote = data.coveredSections.at(-1).topics[0].entries[0].evidence[0];
    if (data.mode === 'retrospective_focus') return response({ followups: [focus({ id: quote.id, text: quoteFrom(data, quote) }, { topicId: data.knownTopics[0].id })], focusFollowupId: 'new_f' });
    return response({ topics: [{ id: 'new_synthesis', title: '画像概念', entries: [{ type: 'viewpoint', text: '栏目和信息是两个对象。', evidence: [quote] }] }], followups: [] });
  }, { retrospectiveMaxChars: budget });
  const { meeting } = seed(store, '第0段原始讨论：栏目与信息混在一起。'.repeat(40));
  for (let i = 1; i < 18; i++) store.appendTranscript(meeting.id, { text: `第${i}段原始讨论：栏目与信息混在一起。`.repeat(40), startMs: i * 2000, endMs: i * 2000 + 1000 });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'done', job.error);
  assert.ok(compressionCalls > 0);
  assert.deepEqual(seen, Array.from({ length: 18 }, (_, i) => `s${i + 1}`));
  assert.equal(store.getMeeting(meeting.id).followups.length, 1);
});

for (const retiredByAI of [false, true]) test(`whole-meeting rereading corrects prior AI interpretation from the same evidence${retiredByAI ? ' and reconsiders a live interruption filter' : ''}`, async t => {
  let first = true;
  const { store, ai } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    const result = focus(data.sources[0], { id: data.existingFollowups[0]?.id || 'new_f', resolution: { outcome: 'clarified', complete: !first, text: first ? '先前AI只记录了部分理解。' : '全场复盘确认原话已把两个对象分开。', evidence: [cite(data.sources[0])] } });
    first = false;
    return response({ followups: [result], focusFollowupId: result.id });
  });
  const { meeting } = seed(store);
  assert.equal((await finish(store, ai.submit(meeting.id, 'organize'))).status, 'done');
  if (retiredByAI) store.mutateMeeting(meeting.id, m => { m.followups[0].attention = { needed: false, reason: '不需要打断当时的讨论。', author: 'ai', sourceRevision: m.transcriptRevision, evidence: m.followups[0].evidence }; });
  const oldId = store.getMeeting(meeting.id).followups[0].id;
  const reread = await finish(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(reread.status, 'done', reread.error);
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.followups.length, 1);
  assert.equal(saved.followups[0].id, oldId);
  assert.equal(saved.followups[0].retrospective, true);
  assert.equal(saved.followups[0].status, 'resolved');
  assert.equal(saved.followups[0].resolution.complete, true);
  assert.equal(saved.followups[0].attention?.needed !== false, true);
  assert.equal(saved.focusFollowupId, oldId);
});

test('topic-stage merges move a host discussion record to the surviving topic before focus failure', async t => {
  const { store, ai } = fixture(t, data => data.mode === 'retrospective_topics' ? response({ topics: [], merges: [{ sourceId: 'old_topic', targetId: 'kept_topic' }], followups: [] }) : new Response('{}', { status: 401 }));
  const { meeting, line } = seed(store);
  store.mutateMeeting(meeting.id, m => {
    const entry = { id: 'old_entry', text: '讨论过栏目更新。', type: 'viewpoint', author: 'ai', status: 'active', sourceRevision: 1, evidenceIds: [line.id], evidence: [cite(line)] };
    m.topics = [{ id: 'old_topic', title: '原议题', entries: [entry] }, { id: 'kept_topic', title: '合并后的议题', entries: [] }];
    m.followups = [{ id: 'host_record', topicId: 'old_topic', author: 'host', status: 'recorded', question: '主持人关注的事项', resolution: { text: '单独保留这份人工记录。', outcome: 'recorded', complete: false, author: 'host' } }];
  });
  const job = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(job.status, 'error');
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.topics[0].mergedInto, 'kept_topic');
  assert.equal(saved.followups[0].topicId, 'kept_topic');
  assert.equal(saved.followups[0].resolution.text, '单独保留这份人工记录。');
});

test('extra full-source extraction after publishing topics is cached when focus fails', async t => {
  let failFocus = true;
  const { store, ai, calls } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') {
      const source = { ...data.sources[0], text: data.sources[0].text.slice(0, 20) };
      return response({ topics: [{ ...topic(source), summary: '栏目和具体的信息有不同的更新机制。'.repeat(50), entries: [{ type: 'viewpoint', text: '栏目结构与信息值分开考虑其更新条件。'.repeat(65), evidence: [cite(source)] }] }], followups: [] });
    }
    if (data.mode === 'retrospective_extract') {
      const source = { ...data.sources.at(-1), text: data.sources.at(-1).text.slice(0, 20) };
      return response({ topics: [topic(source)], followups: [] });
    }
    if (failFocus) return new Response('{}', { status: 401 });
    const evidence = data.coveredSections.at(-1).topics[0].summaryEvidence[0];
    return response({ followups: [focus({ id: evidence.id, text: quoteFrom(data, evidence) })], focusFollowupId: 'new_f' });
  }, { retrospectiveMaxChars: 5000 });
  const { meeting } = seed(store, '第一段讨论栏目与用户信息。'.repeat(65));
  for (let i = 1; i < 3; i++) store.appendTranscript(meeting.id, { text: `第${i}段讨论栏目与用户信息。`.repeat(65), startMs: i * 2000, endMs: i * 2000 + 1000 });
  const failed = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(failed.status, 'error');
  const saved = store.getMeeting(meeting.id);
  assert.equal(saved.retrospectiveAnalysis.material.kind, 'section_summaries');
  const oldCalls = calls.length;
  failFocus = false;
  const retry = await finish(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(retry.status, 'done', retry.error);
  assert.deepEqual(calls.slice(oldCalls).map(item => item.mode), ['retrospective_focus']);
});

test('an oversized extracted section is re-extracted from smaller original ranges without losing late speech', async t => {
  const accepted = [], oversized = [];
  const { store, ai } = fixture(t, data => {
    assert.ok(JSON.stringify(data).length <= 5000);
    if (data.mode === 'retrospective_extract') {
      const item = topic(data.sources.at(-1));
      if (data.sources.length > 2) {
        oversized.push(data.sources.map(source => source.id));
        item.summary = '模型过度展开了这段材料。'.repeat(600);
      } else accepted.push(...data.sources.map(source => source.id));
      return response(idsOnly({ topics: [item], followups: [] }));
    }
    if (data.coverage.complete) {
      assert.equal(data.coveredSections.reduce((sum, part) => sum + part.sourceSpan.count, 0), 12);
      assert.equal(data.coveredSections.at(-1).sourceSpan.to, 's12');
    }
    const evidence = data.coveredSections.at(-1).topics[0].summaryEvidence[0];
    const source = { id: evidence.id, text: quoteFrom(data, evidence) };
    if (data.mode === 'retrospective_synthesis') return response(idsOnly({ topics: [topic(source)], followups: [] }));
    return response(idsOnly({ followups: [focus(source)], focusFollowupId: 'new_f' }));
  }, { retrospectiveMaxChars: 5000 });
  const { meeting } = seed(store, '第0段原话。'.repeat(90));
  for (let i = 1; i < 12; i++) store.appendTranscript(meeting.id, { text: `第${i}段原话。`.repeat(90), startMs: i * 2000, endMs: i * 2000 + 1000 });
  const result = await finish(store, ai.submit(meeting.id, 'minutes'));
  assert.equal(result.status, 'done', result.error);
  assert.ok(oversized.length > 0);
  assert.deepEqual(accepted, Array.from({ length: 12 }, (_, i) => `s${i + 1}`));
  assert.ok(result.stages.some(stage => stage.outputChars > 5000));
  assert.ok(result.stages.every(stage => stage.inputChars <= 5000));
  assert.equal(store.getMeeting(meeting.id).processedLineCount, 12);
  assert.ok(store.getMeeting(meeting.id).artifacts.some(item => item.type === 'minutes'));
});

for (const shrinksOnRetry of [true, false]) test(`nonshrinking compression retries with a tighter budget and ${shrinksOnRetry ? 'recovers' : 'fails without publishing partial topics'}`, async t => {
  const attempts = new Map();
  const { store, ai, calls } = fixture(t, (data, { body }) => {
    assert.ok(JSON.stringify(data).length <= 5000);
    if (data.mode === 'retrospective_extract') {
      const source = { ...data.sources.at(-1), text: data.sources.at(-1).text.slice(0, 20) };
      return response({ topics: [{ ...topic(source), summary: '同一事项的补充说明。'.repeat(180) }], followups: [] });
    }
    const evidence = data.coveredSections.at(-1).topics[0].summaryEvidence[0];
    const source = { id: evidence.id, text: quoteFrom(data, evidence) };
    if (!data.coverage.complete) {
      assert.match(body.messages[0].content, /压缩中间提要/);
      assert.ok(data.outputBudgetChars > 0);
      const key = data.coveredSections[0].sourceSpan.from;
      const previous = attempts.get(key);
      attempts.set(key, data.outputBudgetChars);
      if (previous) assert.ok(data.outputBudgetChars < previous);
      if (!previous || !shrinksOnRetry) return response(idsOnly({ topics: data.coveredSections.flatMap(section => section.topics).map(item => ({ ...item, summary: '压缩失败后反而增加的说明。'.repeat(600) })), followups: [] }));
    }
    if (data.mode === 'retrospective_synthesis') return response(idsOnly({ topics: [topic(source)], followups: [] }));
    return response(idsOnly({ followups: [focus(source)], focusFollowupId: 'new_f' }));
  }, { retrospectiveMaxChars: 5000 });
  const { meeting } = seed(store, '第0段原始讨论。'.repeat(90));
  for (let i = 1; i < 12; i++) store.appendTranscript(meeting.id, { text: `第${i}段原始讨论。`.repeat(90), startMs: i * 2000, endMs: i * 2000 + 1000 });
  const result = await finish(store, ai.submit(meeting.id, 'organize'));
  assert.equal(result.status, shrinksOnRetry ? 'done' : 'error', result.error);
  const compression = calls.filter(data => data.mode === 'retrospective_synthesis' && !data.coverage.complete);
  assert.ok(compression.length > 0);
  assert.equal(compression.length, attempts.size * 2);
  if (!shrinksOnRetry) {
    assert.match(result.error, /两次压缩/);
    assert.equal(store.getMeeting(meeting.id).topics.length, 0);
  }
});

test('an unsupported nonempty focus is an error, not a successful empty selection', async t => {
  let unsupported = false;
  const { store, ai } = fixture(t, data => {
    if (data.mode === 'retrospective_topics') return response({ topics: [topic(data.sources[0])], followups: [] });
    return response({ followups: [focus(data.sources[0], { id: data.existingFollowups[0]?.id || 'new_f', ...(unsupported ? { evidence: [] } : {}) })], focusFollowupId: 'new_f' });
  });
  const { meeting } = seed(store);
  assert.equal((await finish(store, ai.submit(meeting.id, 'organize'))).status, 'done');
  const original = store.getMeeting(meeting.id).followups[0];
  unsupported = true;
  const job = await finish(store, ai.submit(meeting.id, 'organize', { force: true }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /格式无效/);
  assert.deepEqual(store.getMeeting(meeting.id).followups[0], original);
  assert.equal(store.getMeeting(meeting.id).retrospectiveAnalysis.focusCompleted, false);
});
