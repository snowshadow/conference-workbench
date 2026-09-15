import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { createWorkbench } from '../server/app.js';
import { createMeetingListController } from '../src/lib/use-meeting-list.js';

function seed(store, count, archived = false) {
  const meetings = [];
  for (let index = 0; index < count; index++) {
    const meeting = store.createMeeting({ title: `会议 ${index}` });
    // Deliberate ties test the cursor's ID tiebreaker independently of the clock.
    meeting.createdAt = `2026-09-${String(1 + Math.floor(index / 3)).padStart(2, '0')}T10:00:00.000Z`;
    meeting.archived = archived;
    store.persistMeeting(meeting);
    meetings.push(meeting);
  }
  return meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
function fixture(t) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-list-')));
  t.after(() => store.close());
  return store;
}
function storeRequest(store, requests = []) {
  return async resource => {
    requests.push(resource);
    const query = new URL(resource, 'http://local').searchParams;
    return store.listMeetingsPage({ archived: query.get('archived') === '1', limit: query.get('limit'), ...(query.has('cursor') ? { cursor: query.get('cursor') } : {}) });
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const page = (ids, nextCursor = null) => ({ meetings: ids.map(id => ({ id, title: id })), nextCursor, hasMore: Boolean(nextCursor) });

test('meeting pages use stable creation order, return summaries, and never read transcript projections', t => {
  const store = fixture(t), expected = seed(store, 45);
  seed(store, 4, true);
  store.mutateMeeting(expected[0].id, meeting => { meeting.topics = [{ id: 'one' }, { id: 'old', mergedInto: 'one' }]; });
  store.updateMeeting(expected.at(-1).id, { title: '刚刚更新，但仍在最后' });
  store.getMeeting = () => { throw new Error('Paged list must not hydrate meetings or transcripts'); };
  const seen = [];
  let cursor;
  do {
    const result = store.listMeetingsPage({ limit: 20, ...(cursor ? { cursor } : {}) });
    assert.ok(result.meetings.length <= 20);
    seen.push(...result.meetings);
    assert.equal(result.hasMore, Boolean(result.nextCursor));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.map(item => item.id), expected.map(item => item.id));
  assert.equal(seen[0].topicCount, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['archived', 'createdAt', 'goal', 'id', 'status', 'title', 'topicCount', 'transcriptRevision', 'updatedAt']);
  assert.equal(store.listMeetingsPage({ archived: true }).meetings.length, 4);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM meetings WHERE coalesce(json_extract(data,'$.archived'),0)=? AND (json_extract(data,'$.createdAt'),id)<(?,?) ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?").all(0, expected[0].createdAt, expected[0].id, 21);
  assert.ok(plan.some(row => row.detail.includes('meetings_created_page')));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
});

test('cursor survives archiving its boundary and does not skip later meetings', t => {
  const store = fixture(t), expected = seed(store, 25);
  const first = store.listMeetingsPage({ limit: 20 });
  store.updateMeeting(first.meetings.at(-1).id, { archived: true });
  store.createMeeting({ title: '新会议' });
  const rest = store.listMeetingsPage({ limit: 20, cursor: first.nextCursor });
  assert.deepEqual(rest.meetings.map(item => item.id), expected.slice(20).map(item => item.id));
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 'invalid' }, { cursor: '' }, { cursor: 'wrong' }, { cursor: Buffer.from('{}').toString('base64url') }]) {
    assert.throws(() => store.listMeetingsPage(input), error => error.status === 400);
  }
});

test('GET meeting list preserves the legacy response while pagination returns only requested rows', async t => {
  const workbench = createWorkbench({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-list-api-')) });
  t.after(() => workbench.close());
  workbench.server.listen(0, '127.0.0.1');
  await once(workbench.server, 'listening');
  const base = `http://127.0.0.1:${workbench.server.address().port}`;
  seed(workbench.store, 23);
  const legacy = await (await fetch(`${base}/api/meetings`)).json();
  assert.deepEqual(Object.keys(legacy), ['meetings']);
  assert.equal(legacy.meetings.length, 23);
  const first = await (await fetch(`${base}/api/meetings?limit=20`)).json();
  assert.equal(first.meetings.length, 20); assert.equal(first.hasMore, true);
  const second = await (await fetch(`${base}/api/meetings?limit=20&cursor=${first.nextCursor}`)).json();
  assert.equal(second.meetings.length, 3); assert.equal(second.nextCursor, null);
  assert.equal((await fetch(`${base}/api/meetings?limit=bad`)).status, 400);
});

test('list controller refreshes all loaded pages and fills gaps left by archived meetings', async t => {
  const store = fixture(t), expected = seed(store, 9), requests = [];
  const list = createMeetingListController({ pageSize: 3, request: storeRequest(store, requests) });
  assert.equal(list.getSnapshot().loading, true);
  await list.refresh(); await list.loadMore();
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), expected.slice(0, 6).map(item => item.id));
  store.updateMeeting(expected[1].id, { archived: true });
  store.updateMeeting(expected[4].id, { title: '标题已修改' });
  await list.refresh();
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), expected.slice(0, 7).filter((_, index) => index !== 1).map(item => item.id));
  assert.equal(list.getSnapshot().meetings.find(item => item.id === expected[4].id).title, '标题已修改');
  await list.loadMore();
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), expected.filter((_, index) => index !== 1).map(item => item.id));
  assert.equal(list.getSnapshot().hasMore, false);
  const priorCount = requests.length; await list.loadMore(); assert.equal(requests.length, priorCount);
  assert.ok(requests.every(resource => new URL(resource, 'http://local').searchParams.get('limit') === '3'));
});

test('list controller keeps existing rows after errors, retries append, and deduplicates responses', async () => {
  let calls = 0;
  const list = createMeetingListController({ pageSize: 2, request: async () => {
    calls++;
    if (calls === 1) return page(['a', 'b'], 'next');
    if (calls === 2) throw new Error('暂时断开');
    return page(['b', 'c']);
  } });
  await list.refresh(); await list.loadMore();
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), ['a', 'b']);
  assert.equal(list.getSnapshot().error, '暂时断开');
  assert.equal(list.getSnapshot().loadingMore, false);
  await list.loadMore();
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(list.getSnapshot().error, '');
});

test('archive switches and cancellation discard late replies even if transport ignores abort', async () => {
  const first = deferred(), archived = deferred(), requests = [];
  const list = createMeetingListController({ request: (resource, options) => {
    requests.push({ resource, signal: options.signal });
    return requests.length === 1 ? first.promise : archived.promise;
  } });
  const initial = list.refresh();
  const switched = list.refresh(true);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(list.getSnapshot().archived, true);
  archived.resolve(page(['archived'])); await switched;
  first.resolve(page(['wrong-scope'], 'next')); await initial;
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), ['archived']);
  const late = deferred();
  const cancelled = createMeetingListController({ request: () => late.promise });
  const pending = cancelled.refresh(); cancelled.cancel();
  late.resolve(page(['unmounted'])); await pending;
  assert.deepEqual(cancelled.getSnapshot().meetings, []);
});

test('polling never competes with append and a manual refresh waits for the cursor owner', async () => {
  const next = deferred(); let calls = 0;
  const list = createMeetingListController({ pageSize: 2, request: async resource => {
    calls++;
    if (calls === 1 || calls === 3) return page(['a', 'b'], 'next');
    if (calls === 2) return next.promise;
    assert.ok(resource.includes('cursor=next')); return page(['c', 'd']);
  } });
  await list.refresh();
  const more = list.loadMore();
  const polling = list.refresh(undefined, { background: true });
  const manual = list.refresh(); const repeated = list.refresh();
  assert.equal(calls, 2); assert.equal(manual, repeated);
  next.resolve(page(['c', 'd'])); await Promise.all([more, polling, manual]);
  assert.equal(calls, 4);
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(list.getSnapshot().loadingMore, false);
});

test('initial errors remain retryable and new meetings appear on refresh without resetting loaded pages', async t => {
  const store = fixture(t); seed(store, 8);
  const fetchPage = storeRequest(store); let failed = false;
  const list = createMeetingListController({ pageSize: 3, request: async resource => {
    if (!failed) { failed = true; throw new Error('服务未就绪'); }
    return fetchPage(resource);
  } });
  await list.refresh();
  assert.equal(list.getSnapshot().loading, false); assert.equal(list.getSnapshot().loaded, false);
  await list.refresh(); await list.loadMore();
  const fresh = store.createMeeting({ title: '刚导入的会议' });
  await list.refresh(false);
  assert.equal(list.getSnapshot().meetings[0].id, fresh.id);
  assert.equal(list.getSnapshot().meetings.length, 6);
});

test('load more clicks during polling queue one append after manual refresh, and archive changes cancel it', async () => {
  const poll = deferred(), calls = [];
  const list = createMeetingListController({ pageSize: 2, request: async resource => {
    calls.push(resource);
    if (calls.length === 1) return page(['a', 'b'], 'old');
    if (calls.length === 2) return poll.promise;
    if (calls.length === 3) return page(['new', 'a'], 'fresh');
    assert.ok(resource.includes('cursor=fresh')); return page(['b', 'c']);
  } });
  await list.refresh();
  const polling = list.refresh(undefined, { background: true });
  const more = list.loadMore(), repeated = list.loadMore();
  assert.equal(more, repeated); assert.equal(list.getSnapshot().loadingMore, true);
  const manual = list.refresh();
  assert.equal(calls.length, 2);
  poll.resolve(page(['a', 'b'], 'old'));
  await Promise.all([polling, more, manual]);
  assert.equal(calls.length, 4);
  assert.deepEqual(list.getSnapshot().meetings.map(item => item.id), ['new', 'a', 'b', 'c']);
  assert.equal(list.getSnapshot().loadingMore, false);

  const late = deferred(); let count = 0;
  const switching = createMeetingListController({ request: async () => {
    count++;
    if (count === 1) return page(['active'], 'next');
    if (count === 2) return late.promise;
    return page(['archived']);
  } });
  await switching.refresh();
  const delayed = switching.refresh(undefined, { background: true });
  const cancelledMore = switching.loadMore();
  await switching.refresh(true);
  late.resolve(page(['wrong-scope'], 'next'));
  await Promise.all([delayed, cancelledMore]);
  assert.equal(count, 3);
  assert.deepEqual(switching.getSnapshot().meetings.map(item => item.id), ['archived']);
});
