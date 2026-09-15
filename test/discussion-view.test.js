import test from 'node:test';
import assert from 'node:assert/strict';
import { browseFocusIds, focusPriority, isActiveFocus, isReadingFocus, nextFocusId, orderedFocuses, readingFocusId, recommendedFocusId, resolveFocus, returnFocusId, topicReadingEntries } from '../shared/discussion-view.js';

const question = (id, extra = {}) => ({ id, status: 'active', ...extra });

test('retrospectives keep resolved lessons readable without changing factual or live focus status', () => {
  const lesson = question('lesson', { retrospective: true, status: 'resolved', resolution: { complete: true }, priority: { level: 'high' } });
  const pending = question('pending', { retrospective: true, priority: { level: 'medium' } });
  const meeting = { source: 'recording_import', focusFollowupId: null, followups: [pending, lesson] };
  const before = structuredClone(meeting);
  assert.equal(isActiveFocus(lesson), false);
  assert.equal(isReadingFocus(lesson, meeting), true);
  assert.deepEqual(orderedFocuses(meeting).map(item => item.id), ['lesson', 'pending']);
  assert.equal(recommendedFocusId(meeting), 'lesson');
  assert.equal(readingFocusId(meeting, 'lesson'), 'lesson');
  assert.deepEqual(browseFocusIds(meeting, ['lesson', 'pending']), ['lesson', 'pending']);
  assert.equal(nextFocusId(meeting, 'lesson'), 'pending');
  assert.equal(focusPriority(lesson, meeting).label, '优先回看');
  assert.deepEqual(meeting, before);
  assert.equal(isReadingFocus(lesson, { ...meeting, source: undefined }), false);
  assert.equal(focusPriority(lesson).label, '优先讨论');
});

test('retrospective browsing excludes withdrawn, merged and outdated lessons and retains legacy open questions', () => {
  const lesson = question('lesson', { retrospective: true, status: 'resolved', resolution: { complete: true } });
  const meeting = { source: 'recording_import' };
  for (const patch of [{ status: 'ignored' }, { mergedInto: 'other' }, { stale: true }, { resolution: { stale: true } }, { attention: { needed: false } }]) {
    assert.equal(isReadingFocus({ ...lesson, ...patch }, meeting), false);
  }
  assert.equal(isReadingFocus({ ...lesson, status: 'recorded' }, meeting), true);
  assert.equal(isReadingFocus(question('legacy'), meeting), true);
  assert.equal(isReadingFocus({ ...lesson, retrospective: undefined }, meeting), false);
  const completed = { ...meeting, retrospectiveAnalysis: { focusCompleted: true } };
  assert.equal(isReadingFocus(question('old-ai', { author: 'ai' }), completed), false);
  assert.equal(isReadingFocus(question('host', { author: 'host' }), completed), true);
  assert.equal(isReadingFocus(question('edited', { author: 'ai', manualFields: ['question'] }), completed), true);
  assert.equal(isReadingFocus(question('host-result', { author: 'ai', resolution: { author: 'host', complete: false, text: '先核对设备上的范围。' } }), completed), true);
});

test('explicit quiet focus never opens an old question but preserves an active reading position', () => {
  const meeting = { focusFollowupId: null, followups: [question('old')] };
  assert.equal(recommendedFocusId(meeting), null);
  assert.equal(readingFocusId(meeting, null), null);
  assert.equal(readingFocusId(meeting, 'old'), 'old');
  assert.equal(recommendedFocusId({ followups: meeting.followups }), 'old');
});

test('following advances after completion or ignoring, while recommendation changes keep the active reading', () => {
  const followups = [question('old', { status: 'resolved' }), question('next')];
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'next');
  followups[0].status = 'ignored';
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'next');
  followups[0].status = 'active';
  assert.equal(readingFocusId({ focusFollowupId: 'next', followups }, 'old'), 'old');
});

test('three priority groups order active questions stably without counting transcript fragments', () => {
  const meeting = { followups: [question('legacy', { evidenceIds: Array(50).fill('source') }), question('medium', { priority: { level: 'medium' } }), question('high-a', { priority: { level: 'high' } }), question('low', { priority: { level: 'low' } }), question('high-b', { priority: { level: 'high' } }), question('old', { status: 'resolved', priority: { level: 'high' } }), question('retired', { attention: { needed: false }, priority: { level: 'high' } })] };
  const before = structuredClone(meeting);
  assert.deepEqual(orderedFocuses(meeting).map(item => item.id), ['high-a', 'high-b', 'medium', 'low', 'legacy']);
  assert.deepEqual(meeting, before);
  assert.equal(focusPriority(meeting.followups[0]).label, '待排序');
  assert.equal(focusPriority({ priority: { level: 'high', stale: true } }).rank, 0);
  for (const level of [99, 'critical', '__proto__', 'constructor', null]) assert.equal(focusPriority({ priority: { level } }).level, 'unrated');
  assert.equal(focusPriority({ priority: { level: 'high', reason: '  会影响当前范围。 ' } }).reason, '会影响当前范围。');
});

test('priority steers recommendations and automatic progression while same-level context is preserved', () => {
  const meeting = { focusFollowupId: 'read', followups: [question('read', { topicId: 'a', priority: { level: 'medium' } }), question('near', { topicId: 'a', priority: { level: 'low' } }), question('important', { topicId: 'b', priority: { level: 'high' } })] };
  assert.equal(recommendedFocusId(meeting), 'important');
  assert.equal(readingFocusId(meeting, 'read'), 'read');
  assert.equal(returnFocusId(meeting, 'read'), 'important');
  meeting.followups[0].status = 'resolved';
  assert.equal(nextFocusId(meeting, 'read'), 'important');
  assert.equal(readingFocusId(meeting, 'read'), 'important');
  meeting.followups[1].priority.level = 'high';
  assert.equal(nextFocusId(meeting, 'read'), 'near');
  meeting.focusFollowupId = null;
  assert.equal(recommendedFocusId(meeting), null);
});

test('a frozen browsing queue ignores new priorities and additions until refreshed', () => {
  const meeting = { followups: [question('a', { priority: { level: 'high' } }), question('b', { priority: { level: 'medium' } }), question('c', { priority: { level: 'low' } })] };
  const frozen = browseFocusIds(meeting);
  meeting.followups[2].priority.level = 'high';
  meeting.followups[0].priority.level = 'low';
  meeting.followups.push(question('new', { priority: { level: 'high' } }));
  assert.deepEqual(browseFocusIds(meeting, frozen), ['a', 'b', 'c']);
  assert.deepEqual(browseFocusIds(meeting), ['c', 'new', 'b', 'a']);
  meeting.followups[0].status = 'ignored';
  meeting.followups[1].mergedInto = 'c';
  assert.deepEqual(browseFocusIds(meeting, frozen), ['c']);
  assert.deepEqual(browseFocusIds(meeting, []), []);
  assert.deepEqual(browseFocusIds({ followups: [] }), []);
  assert.deepEqual(frozen, ['a', 'b', 'c']);
});

test('a missing or stale recommended item stays quiet instead of selecting the oldest', () => {
  for (const extra of [{ stale: true }, { status: 'resolved', stale: true }]) {
    assert.equal(recommendedFocusId({ focusFollowupId: 'invalid', followups: [question('old'), question('invalid', extra)] }), null);
  }
  assert.equal(recommendedFocusId({ focusFollowupId: 'missing', followups: [question('old')] }), null);
});

test('host recording, completion and dismissal advance without a new model recommendation', () => {
  for (const status of ['recorded', 'resolved', 'ignored']) {
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

test('opening the recommended question sources holds reading without offering a redundant return', () => {
  const meeting = { focusFollowupId: 'current', followups: [question('current'), question('other')] };
  const readingId = readingFocusId(meeting, 'current', false);
  assert.equal(readingId, 'current');
  assert.equal(returnFocusId(meeting, readingId), null);
});

test('reading another question offers the recommendation and returning clears the target', () => {
  const meeting = { focusFollowupId: 'current', followups: [question('current'), question('other')] };
  const readingId = readingFocusId(meeting, 'other', false);
  const target = returnFocusId(meeting, readingId);
  assert.equal(readingId, 'other');
  assert.equal(target, 'current');
  assert.equal(returnFocusId(meeting, readingFocusId(meeting, target, true)), null);
});

test('a new recommendation becomes available without taking away a held question', () => {
  const meeting = { focusFollowupId: 'read', followups: [question('read'), question('next')] };
  assert.equal(returnFocusId(meeting, readingFocusId(meeting, 'read', false)), null);
  meeting.focusFollowupId = 'next';
  const readingId = readingFocusId(meeting, 'read', false);
  assert.equal(readingId, 'read');
  assert.equal(returnFocusId(meeting, readingId), 'next');
});

test('a quiet, missing or stale recommendation never offers an empty return destination', () => {
  const followups = [question('read'), question('stale', { stale: true }), question('stale-result', { status: 'resolved', stale: true })];
  for (const focusFollowupId of [null, 'missing', 'stale', 'stale-result']) {
    assert.equal(returnFocusId({ focusFollowupId, followups }, 'read'), null);
  }
  assert.equal(returnFocusId({ followups: [] }, null), null);
});

test('merged aliases of the same question do not offer a return, including merge chains', () => {
  const meeting = { focusFollowupId: 'old', followups: [question('old', { mergedInto: 'middle' }), question('middle', { mergedInto: 'current' }), question('current')] };
  for (const readingId of ['old', 'middle', 'current']) assert.equal(returnFocusId(meeting, readingId), null);
  meeting.followups[2].mergedInto = 'old';
  assert.equal(returnFocusId(meeting, 'old'), null);
});

test('held completed results can return to a pending question in live or ended meetings', () => {
  for (const status of ['recorded', 'resolved', 'ignored']) {
    for (const lifecycle of ['active', 'ended']) {
      const meeting = { status: lifecycle, focusFollowupId: 'finished', followups: [question('finished', { status }), question('next')] };
      const readingId = readingFocusId(meeting, 'finished', false);
      assert.equal(readingId, 'finished');
      assert.equal(returnFocusId(meeting, readingId), 'next');
      assert.equal(returnFocusId(meeting, readingFocusId(meeting, 'finished', true)), null);
      meeting.focusFollowupId = null;
      assert.equal(returnFocusId(meeting, readingId), null);
    }
  }
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
