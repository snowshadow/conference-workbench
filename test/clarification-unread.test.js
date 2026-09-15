import test from 'node:test';
import assert from 'node:assert/strict';
import { updateClarificationUnread } from '../shared/clarification-unread.js';
import { isActiveFocus } from '../shared/discussion-view.js';

const focus = (id, extra = {}) => ({ id, status: 'active', question: `问题 ${id}`, ...extra });
const meeting = (followups, id = 'meeting-a') => ({ id, followups });
const count = (state, id = 'meeting-a') => state.get(id)?.unreadIds.size || 0;

test('a new resolved retrospective is unread until viewed, while live resolved issues are not reminders', () => {
  const imported = followups => ({ ...meeting(followups), source: 'recording_import' });
  let state = updateClarificationUnread(new Map(), imported([]), 'topics');
  const lesson = focus('lesson', { retrospective: true, status: 'resolved', resolution: { complete: true } });
  state = updateClarificationUnread(state, imported([lesson]), 'topics');
  assert.equal(count(state), 1);
  state = updateClarificationUnread(state, imported([lesson]), 'clarification');
  assert.equal(count(state), 0);
  state = updateClarificationUnread(state, imported([lesson]), 'topics');
  assert.equal(count(state), 0);
  let live = updateClarificationUnread(new Map(), meeting([]), 'topics');
  live = updateClarificationUnread(live, meeting([lesson]), 'topics');
  assert.equal(count(live), 0);
});

test('first loaded snapshot is a baseline even when the topics tab is already selected', () => {
  for (const view of ['clarification', 'topics']) {
    let state = updateClarificationUnread(new Map(), meeting([focus('old'), focus('stale', { stale: true })]), view);
    assert.equal(count(state), 0);
    state = updateClarificationUnread(state, meeting([focus('old'), focus('stale')]), 'topics');
    assert.equal(count(state), 0, 'refreshing an existing stale item is not a newly created question');
  }
});

test('new active focus IDs received while reading topics accumulate once without counting text, rank or revision changes', () => {
  let state = updateClarificationUnread(new Map(), meeting([focus('old')]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('old')]), 'topics');
  state = updateClarificationUnread(state, meeting([focus('old'), focus('new-a')]), 'topics');
  assert.equal(count(state), 1);
  const unchanged = updateClarificationUnread(state, meeting([
    focus('new-a', { question: '问题改了文案', sourceRevision: 50, priority: { level: 'high' } }),
    focus('old', { sourceRevision: 51 }),
  ]), 'topics');
  assert.equal(unchanged, state, 'metadata-only snapshots do not change navigation state');
  state = updateClarificationUnread(state, meeting([focus('new-a'), focus('new-b'), focus('old'), focus('new-b')]), 'topics');
  assert.equal(count(state), 2, 'duplicate IDs cannot inflate the badge');
});

test('opening clarification reads all current questions, including ones arriving in the same update', () => {
  let state = updateClarificationUnread(new Map(), meeting([focus('a')]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('a'), focus('b')]), 'topics');
  assert.equal(count(state), 1);
  state = updateClarificationUnread(state, meeting([focus('a'), focus('b'), focus('c')]), 'clarification');
  assert.equal(count(state), 0);
  state = updateClarificationUnread(state, meeting([focus('a'), focus('b'), focus('c')]), 'topics');
  assert.equal(count(state), 0);
  state = updateClarificationUnread(state, meeting([focus('a'), focus('b'), focus('c'), focus('d')]), 'topics');
  assert.equal(count(state), 1);
});

test('questions created while clarification is visible are read instead of waiting for a later topics visit', () => {
  let state = updateClarificationUnread(new Map(), meeting([]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('new')]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('new')]), 'topics');
  assert.equal(count(state), 0);
});

test('resolved, ignored, merged, stale and de-prioritized questions leave unread using the existing visibility rule', () => {
  for (const change of [
    { status: 'resolved' }, { status: 'recorded' }, { status: 'ignored' },
    { status: 'merged', mergedInto: 'baseline' }, { mergedInto: 'baseline' },
    { stale: true }, { attention: { needed: false } },
  ]) {
    let state = updateClarificationUnread(new Map(), meeting([focus('baseline')]), 'clarification');
    state = updateClarificationUnread(state, meeting([focus('baseline'), focus('new')]), 'topics');
    assert.equal(count(state), 1);
    const changed = focus('new', change);
    assert.equal(isActiveFocus(changed), false);
    state = updateClarificationUnread(state, meeting([focus('baseline'), changed]), 'topics');
    assert.equal(count(state), 0);
    state = updateClarificationUnread(state, meeting([focus('baseline'), focus('new')]), 'topics');
    assert.equal(count(state), 0, 'an already encountered issue does not become new again');
  }
});

test('deleted questions cannot leave a stale unread badge', () => {
  let state = updateClarificationUnread(new Map(), meeting([]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('removed')]), 'topics');
  assert.equal(count(state), 1);
  state = updateClarificationUnread(state, meeting([]), 'topics');
  assert.equal(count(state), 0);
});

test('unread follows the panel active-focus rule instead of adding stricter priority or resolution filters', () => {
  const candidates = [
    focus('partial', { resolution: { complete: false, stale: true } }),
    focus('unranked'),
    focus('low', { priority: { level: 'low' } }),
    focus('old-priority', { priority: { stale: true, level: 'high' } }),
    focus('quiet', { attention: { needed: false } }),
    focus('resolved', { status: 'resolved' }),
  ];
  let state = updateClarificationUnread(new Map(), meeting([]), 'clarification');
  state = updateClarificationUnread(state, meeting(candidates), 'topics');
  assert.deepEqual([...state.get('meeting-a').unreadIds], candidates.filter(isActiveFocus).map(item => item.id));
});

test('meeting sessions remain isolated through loading and navigation, including colliding focus IDs', () => {
  let state = updateClarificationUnread(new Map(), meeting([]), 'clarification');
  state = updateClarificationUnread(state, meeting([focus('same-id')]), 'topics');
  assert.equal(count(state), 1);
  const loading = updateClarificationUnread(state, null, 'clarification');
  assert.equal(loading, state);
  state = updateClarificationUnread(state, meeting([focus('same-id')], 'meeting-b'), 'topics');
  assert.equal(count(state, 'meeting-b'), 0); assert.equal(count(state), 1);
  state = updateClarificationUnread(state, meeting([focus('same-id'), focus('b-new')], 'meeting-b'), 'topics');
  assert.equal(count(state, 'meeting-b'), 1); assert.equal(count(state), 1);
  state = updateClarificationUnread(state, meeting([focus('same-id')]), 'clarification');
  assert.equal(count(state), 0); assert.equal(count(state, 'meeting-b'), 1);
});

test('updates do not mutate the meeting or an earlier session snapshot', () => {
  const snapshot = meeting([focus('a')]);
  const original = structuredClone(snapshot);
  const before = updateClarificationUnread(new Map(), snapshot, 'clarification');
  const after = updateClarificationUnread(before, meeting([focus('a'), focus('b')]), 'topics');
  assert.deepEqual(snapshot, original);
  assert.equal(count(before), 0); assert.equal(count(after), 1);
  assert.deepEqual([...before.get('meeting-a').knownIds], ['a']);
});
