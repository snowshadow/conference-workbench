import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveFocus, readingFocusId, recommendedFocusId, resolveFocus, topicReadingEntries } from '../shared/discussion-view.js';

const question = (id, extra = {}) => ({ id, status: 'active', ...extra });

test('explicit quiet focus never fills the screen from an old question queue', () => {
  const meeting = { focusFollowupId: null, followups: [question('old')] };
  assert.equal(recommendedFocusId(meeting), null);
  assert.equal(readingFocusId(meeting, 'old'), null);
  assert.equal(recommendedFocusId({ followups: meeting.followups }), 'old');
});

test('default following advances after completion, ignoring, and recommendation changes', () => {
  const followups = [question('old', { status: 'resolved' }), question('next')];
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'next');
  followups[0].status = 'ignored';
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'next');
  followups[0].status = 'active';
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'next');
});

test('a missing or stale recommended item stays quiet instead of selecting the oldest', () => {
  for (const extra of [{ stale: true }, { status: 'resolved', stale: true }]) {
    assert.equal(recommendedFocusId({ focusFollowupId: 'invalid', followups: [question('old'), question('invalid', extra)] }), null);
  }
  assert.equal(recommendedFocusId({ focusFollowupId: 'missing', followups: [question('old')] }), null);
});

test('host completion advances without waiting for a new model recommendation', () => {
  for (const status of ['resolved', 'ignored']) {
    const meeting = { focusFollowupId: 'current', followups: [
      question('earlier', { topicId: 'topic' }),
      question('current', { status, topicId: 'topic' }),
      question('stale', { topicId: 'topic', stale: true }),
      question('merged', { topicId: 'topic', mergedInto: 'next' }),
      question('unrelated', { topicId: 'other' }),
      question('next', { topicId: 'topic' }),
    ] };
    assert.equal(recommendedFocusId(meeting), 'next');
    assert.equal(readingFocusId(meeting, 'current'), 'next');
    assert.equal(readingFocusId(meeting, 'current', false), 'current');
  }
});

test('host completion prefers the same topic, then later questions, then earlier ones', () => {
  const meeting = { focusFollowupId: 'current', followups: [
    question('earlier', { topicId: 'topic' }),
    question('current', { status: 'resolved', topicId: 'topic' }),
    question('later', { topicId: 'other' }),
  ] };
  assert.equal(recommendedFocusId(meeting), 'earlier');
  meeting.followups[0].topicId = 'other';
  assert.equal(recommendedFocusId(meeting), 'later');
  meeting.followups[2].status = 'resolved';
  assert.equal(recommendedFocusId(meeting), 'earlier');
  meeting.followups[0].stale = true;
  assert.equal(recommendedFocusId(meeting), null);
});

test('a model quiet recommendation wins even after the host finishes an item', () => {
  const meeting = { focusFollowupId: null, followups: [question('finished', { status: 'resolved' }), question('other')] };
  assert.equal(readingFocusId(meeting, 'finished'), null);
});

test('editing and external dialogs pause following temporarily without changing a deliberate reading hold', () => {
  const meeting = { focusFollowupId: 'editing', followups: [question('editing'), question('next')] };
  assert.equal(readingFocusId(meeting, 'editing', true, true), 'editing');
  meeting.followups[0].status = 'resolved';
  assert.equal(readingFocusId(meeting, 'editing', true, true), 'editing');
  assert.equal(readingFocusId(meeting, 'editing', true, false), 'next');
  assert.equal(readingFocusId(meeting, 'editing', false, true), 'editing');
  assert.equal(readingFocusId(meeting, 'editing', false, false), 'editing');
});

test('reading sources or an explicitly selected result keeps that item until returning to current', () => {
  const meeting = { focusFollowupId: 'next', followups: [question('read', { status: 'resolved' }), question('next')] };
  assert.equal(readingFocusId(meeting, 'read', false), 'read');
  assert.equal(readingFocusId(meeting, 'read', true), 'next');
  meeting.focusFollowupId = null;
  assert.equal(readingFocusId(meeting, 'read', false), 'read');
  assert.equal(readingFocusId(meeting, 'read', true), null);
});

test('merged questions redirect to their target and never remain eligible themselves', () => {
  const meeting = { focusFollowupId: 'a', followups: [question('a', { mergedInto: 'b' }), question('b', { mergedInto: 'c' }), question('c')] };
  assert.equal(recommendedFocusId(meeting), 'c');
  assert.equal(readingFocusId(meeting, 'a', false), 'c');
  assert.equal(isActiveFocus(meeting.followups[0]), false);
  meeting.followups[2].mergedInto = 'a';
  assert.equal(resolveFocus(meeting, 'a'), null);
  assert.equal(recommendedFocusId(meeting), null);
});

test('partial progress remains an active focus', () => {
  const item = question('partial', { resolution: { outcome: 'clarified', complete: false, text: '交接方式已说明，触发标准仍未定。' } });
  assert.equal(isActiveFocus(item), true);
  assert.equal(recommendedFocusId({ focusFollowupId: item.id, followups: [item] }), item.id);
});

test('topic reading shows a few current items while keeping decisions and actions visible', () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({ id: `v${index}`, type: 'viewpoint', status: 'active' }));
  entries.push({ id: 'decision', type: 'decision', status: 'active' }, { id: 'action', type: 'action', status: 'open' });
  const result = topicReadingEntries(entries);
  assert.deepEqual(result.visible.map(entry => entry.id), ['v0', 'v1', 'v2', 'decision', 'action']);
  assert.deepEqual(result.more.map(entry => entry.id), ['v3', 'v4', 'v5', 'v6', 'v7']);
  assert.equal(result.history.length, 0);
});

test('decisions and actions are not cut off by the reading limit', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ id: String(index), type: index % 2 ? 'action' : 'decision', status: 'active' }));
  const result = topicReadingEntries(entries);
  assert.equal(result.visible.length, 7);
  assert.equal(result.more.length, 0);
});

test('answered questions, replaced items and stale sources stay in discussion history', () => {
  const entries = [
    { id: 'answered', type: 'question', status: 'resolved' },
    { id: 'old-view', type: 'viewpoint', status: 'superseded' },
    { id: 'stale-decision', type: 'decision', status: 'active', stale: true },
    { id: 'open', type: 'question', status: 'open' },
  ];
  const result = topicReadingEntries(entries);
  assert.deepEqual(result.visible.map(entry => entry.id), ['open']);
  assert.deepEqual(result.history.map(entry => entry.id), ['answered', 'old-view', 'stale-decision']);
  assert.deepEqual(result.more, []);
});
