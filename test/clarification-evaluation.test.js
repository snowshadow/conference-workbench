import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCases, validateCases, sourcesAt, transcriptPrefix, runEvaluation } from '../scripts/evaluate-clarification.mjs';

test('public evidence is synthetic and forbids later evidence', () => {
  const fixture = validateCases(loadCases());
  assert.ok(fixture.cases.every(item => item.provenance.kind === 'synthetic' && item.provenance.note && item.sources.every(source => source.provenance.kind === 'synthetic')));
  const holdout = fixture.cases.find(item => item.id === 'synthetic-shared-sla-assumption');
  assert.equal(holdout.provenance.role, 'holdout');
  assert.equal(holdout.stages[0].scriptedReply.followups[0].clarification.distinctions, undefined);
  const early = fixture.cases.find(item => item.id === 'synthetic-template-stability');
  const available = sourcesAt(early.sources, early.stages[0].cutoffMs);
  assert.ok(available.every(source => source.endMs <= 30_000));
  assert.ok(!available.some(source => source.id === 'synthetic-template-4'));
  const tampered = structuredClone(fixture);
  tampered.cases[0].stages[0].scriptedReply.followups[0].clarification.evidence.push({ id: 'synthetic-template-4', quote: '固定的是栏目' });
  assert.throws(() => validateCases(tampered), /after cutoff or outside fixture/);
});

test('complete-prefix reading excludes the turn still being spoken and all future definitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clarification-prefix-'));
  const path = join(dir, 'source.txt');
  writeFileSync(path, '甲  00:00:01\n之前的观点。\n\n乙  00:00:04\n尚未说完的定义。\n\n丙  00:00:10\n未来的结论。\n');
  assert.deepEqual(transcriptPrefix(path, 7_000).map(source => source.text), ['之前的观点。']);
  assert.deepEqual(transcriptPrefix(path, 10_000).map(source => source.text), ['之前的观点。', '尚未说完的定义。']);
});

test('offline replay exercises persisted explanations and resolved questions without a live model', async () => {
  const fixture = loadCases();
  const report = await runEvaluation({ fixture, outRoot: mkdtempSync(join(tmpdir(), 'clarification-eval-')) });
  assert.equal(report.mode, 'offline-scripted');
  assert.equal(report.qualityVerdict, 'requires_human_review');
  assert.equal(report.structuralPassed, true);
  const evolution = report.cases.find(item => item.id === 'synthetic-summary-reference-evolution');
  assert.equal(evolution.stages[0].followups[0].status, 'active');
  assert.equal(evolution.stages[1].followups[0].status, 'resolved');
  for (const item of report.cases) {
    const original = fixture.cases.find(candidate => candidate.id === item.id);
    const calls = JSON.parse(readFileSync(join(report.outDir, item.id, 'model-calls.json'), 'utf8'));
    for (const call of calls) {
      const stage = original.stages.find(stage => stage.id === call.stage);
      const allowed = new Set(sourcesAt(original.sources, stage.cutoffMs).map(source => source.id));
      const input = JSON.parse(call.request.messages[1].content);
      assert.ok(input.sources.every(source => allowed.has(source.id)));
      assert.equal(Object.hasOwn(input, 'scriptedReply'), false);
      assert.equal(Object.hasOwn(input, 'expected'), false);
      assert.equal(Object.hasOwn(call.request, 'headers'), false);
    }
  }
});

test('retirement preserves incomplete work instead of equating leaving focus with resolution', async () => {
  const report = await runEvaluation({ caseIds: ['synthetic-export-scope'], outRoot: mkdtempSync(join(tmpdir(), 'clarification-retirement-')) });
  const residual = report.cases[0].stages[0];
  assert.equal(residual.activeCount, 0);
  assert.equal(residual.followups[0].status, 'active');
  assert.equal(residual.followups[0].attention.needed, false);
  assert.ok(residual.followups[0].attention.evidenceIds.length);
  assert.equal(residual.followups[0].resolution.complete, false);
});
