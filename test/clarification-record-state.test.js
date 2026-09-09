import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { editFollowup } from '../server/content.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { clarificationRecordReview } from '../shared/clarification-record-state.js';

function fixture(t) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'clarification-record-state-')));
  t.after(() => store.close());
  const meeting = store.createMeeting({ title: '讨论记录的来源状态' });
  const line = store.appendTranscript(meeting.id, { text: '1.0 先支持三个角色。', speakerId: 'speaker-5' });
  store.mutateMeeting(meeting.id, current => {
    current.followups = [{ id: 'focus', question: '1.0 支持几个角色？', status: 'active', author: 'ai', evidenceIds: [line.id] }];
  });
  const current = () => store.getMeeting(meeting.id).followups[0];
  const record = (author, evidenceIds) => editFollowup(store, meeting.id, 'focus', {
    status: 'recorded', author, sourceRevision: 1, transcriptEditRevision: 0,
    resolution: { outcome: 'recorded', text: '平台保留多角色能力，1.0 先做三个。', evidenceIds },
  });
  return { store, meeting, line, current, record };
}

test('question flags do not describe the validity of a saved record', () => {
  assert.equal(clarificationRecordReview(null), null);
  assert.equal(clarificationRecordReview({ stale: true, pendingReview: true }), null);
  for (const author of ['host', 'agent', 'ai']) {
    assert.equal(clarificationRecordReview({ stale: true, pendingReview: true, resolution: { author, stale: false, pendingReview: false } }), null);
  }
  // Legacy question-level flags can remain on an otherwise valid manual record.
  for (const author of ['host', 'agent']) {
    assert.equal(clarificationRecordReview({ pendingReview: true, resolution: { author, pendingReview: true } }), null);
  }
});

for (const author of ['host', 'agent']) {
  for (const cited of [false, true]) {
    test(`${author} record ${cited ? 'with' : 'without'} citations stays current when speech arrives before or after saving`, t => {
      const f = fixture(t);
      f.store.appendTranscript(f.meeting.id, { text: '接下来讨论硬件。' });
      f.record(author, cited ? [f.line.id] : []);
      const saved = f.current();
      assert.equal(saved.pendingReview, true, 'the unresolved question can still await later analysis');
      assert.equal(saved.resolution.sourceRevision, 1);
      assert.equal(clarificationRecordReview(saved), null);
      f.store.appendTranscript(f.meeting.id, { text: '还有一个外观问题。' });
      assert.deepEqual(f.current().resolution, saved.resolution);
      assert.equal(clarificationRecordReview(f.current()), null);
    });
  }
}

test('changing the original question evidence does not invalidate an uncited host record', t => {
  const f = fixture(t);
  f.record('host', []);
  f.store.editTranscript(f.meeting.id, f.line.id, { text: '1.0 先讨论三个角色。' });
  assert.equal(f.current().stale, true);
  assert.equal(f.current().resolution.stale, false);
  assert.equal(clarificationRecordReview(f.current()), null);
});

for (const patch of [{ text: '1.0 先支持两个角色。' }, { speakerId: 'speaker-2' }]) {
  test(`a real ${patch.text ? 'text' : 'speaker attribution'} correction keeps the saved record visible but requests source review`, t => {
    const f = fixture(t);
    f.record('host', [f.line.id]);
    const saved = f.current().resolution;
    f.store.editTranscript(f.meeting.id, f.line.id, patch);
    assert.equal(clarificationRecordReview(f.current()), 'source_changed');
    assert.equal(f.current().resolution.text, saved.text);
    assert.deepEqual(f.current().resolution.evidence, saved.evidence);
    assert.equal(f.current().status, 'recorded');
  });
}

test('naming a speaker leaves the cited manual record current', t => {
  const f = fixture(t);
  f.record('agent', [f.line.id]);
  f.store.updateMeeting(f.meeting.id, { speakerLabels: { 'speaker-5': '孙总' } });
  assert.equal(clarificationRecordReview(f.current()), null);
});

test('legacy records without an author only request review for changed sources', () => {
  assert.equal(clarificationRecordReview({ pendingReview: true, resolution: { pendingReview: true } }), null);
  assert.equal(clarificationRecordReview({ resolution: { pendingReview: true, stale: true } }), 'source_changed');
});

test('AI records distinguish unchecked later speech from corrected sources', t => {
  const f = fixture(t);
  const payload = { resolvedFollowups: [{ id: 'focus', resolution: { outcome: 'clarified', complete: true, text: '1.0 先支持三个角色。' }, evidence: [{ id: f.line.id, quote: f.line.text }] }] };
  f.store.mutateMeeting(f.meeting.id, current => Object.assign(current, reduceOrganization(current, payload, [f.line], { fresh: false })));
  assert.equal(clarificationRecordReview(f.current()), 'newer_speech');
  f.store.mutateMeeting(f.meeting.id, current => Object.assign(current, reduceOrganization(current, payload, [f.line], { fresh: true })));
  assert.equal(clarificationRecordReview(f.current()), null);
  f.store.editTranscript(f.meeting.id, f.line.id, { text: '1.0 先支持两个角色。' });
  assert.equal(clarificationRecordReview(f.current()), 'source_changed');
});
