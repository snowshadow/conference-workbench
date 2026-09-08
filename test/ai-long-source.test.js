import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createAIService } from '../server/ai/service.js';

test('a 7000-character source preserves valid citations from both split parts', async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'meeting-ai-long-source-')));
  store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' } });
  const quotes = ['前段提出先验证延迟。', '尾段提出核对成本。'];
  const text = quotes[0].padEnd(6500, '甲') + quotes[1].padEnd(500, '乙');
  const calls = [];
  const ai = createAIService({ store, fetchImpl: async (_url, request) => {
    const data = JSON.parse(JSON.parse(request.body).messages[1].content);
    calls.push(data);
    if (data.mode === 'followup') return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [], followups: [] }) } }] }));
    const entries = data.sources.map(source => {
      const quote = quotes.find(quote => source.text.includes(quote));
      return { type: 'viewpoint', text: quote, evidence: [{ id: source.id, quote }] };
    });
    const payload = { topics: [{ id: data.knownTopics[0]?.id || 'new_1', title: '方案验证', entries }], followups: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }));
  } });
  t.after(async () => { await ai.stop(); store.close(); });
  ai.start();
  const meeting = store.createMeeting({ title: '长行引用回归', autoOrganize: false });
  const source = store.appendTranscript(meeting.id, { text });
  const submitted = ai.submit(meeting.id, 'organize');
  const until = Date.now() + 5000;
  let job;
  do {
    job = store.getJob(submitted.id);
    if (['done', 'error', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 3));
  } while (Date.now() < until);

  assert.equal(job.status, 'done', job.error || 'AI fixture did not finish');
  const organized = store.getMeeting(meeting.id);
  assert.equal(organized.topics.length, 1);
  const entries = organized.topics[0].entries;
  assert.deepEqual(entries.map(entry => entry.text), quotes, 'both original quotes must survive grounding');
  assert.ok(entries.every(entry => entry.evidenceIds.length === 1 && entry.evidenceIds[0] === source.id));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => new Set(call.sources.map(line => line.id)).size === call.sources.length));
  assert.equal(calls.filter(call => call.mode === 'organize').flatMap(call => call.sources).map(line => line.text).join(''), text);
  assert.equal(organized.processedRevision, 1);
});
