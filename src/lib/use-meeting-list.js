import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api.js';

const unique = meetings => [...new Map(meetings.map(meeting => [meeting.id, meeting])).values()];

// One request chain owns the cursor at a time. Keeping this small controller
// outside React also makes interrupted requests and pagination testable.
export function createMeetingListController({ archived = false, pageSize = 20, request = api } = {}) {
  let state = { archived, meetings: [], loading: true, loadingMore: false, refreshing: false, error: '', hasMore: false, nextCursor: null, loaded: false };
  let pages = 1, generation = 0, active = null, queuedRefresh = null, queuedMore = null;
  const listeners = new Set();
  const update = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  function cancel() {
    generation++;
    active?.controller.abort();
    active = null;
    queuedRefresh = null;
    queuedMore = null;
  }
  function setArchived(value) {
    value = Boolean(value);
    if (state.archived === value) return;
    cancel(); pages = 1;
    update({ archived: value, meetings: [], loading: true, loadingMore: false, refreshing: false, error: '', hasMore: false, nextCursor: null, loaded: false });
  }
  function run(kind) {
    const token = { kind, generation, archived: state.archived, controller: new AbortController(), promise: null };
    active = token;
    const current = () => active === token && token.generation === generation && token.archived === state.archived;
    update({ loading: !state.loaded, loadingMore: kind === 'more' || Boolean(queuedMore), refreshing: kind === 'refresh' && state.loaded, error: '' });
    token.promise = (async () => {
      try {
        const results = [];
        let cursor = kind === 'more' ? state.nextCursor : null, result;
        const pageCount = kind === 'more' ? 1 : pages;
        for (let index = 0; index < pageCount; index++) {
          const query = new URLSearchParams({ limit: String(pageSize), ...(token.archived ? { archived: '1' } : {}), ...(cursor ? { cursor } : {}) });
          result = await request(`/api/meetings?${query}`, { signal: token.controller.signal });
          if (!current()) return state;
          results.push(...result.meetings);
          cursor = result.nextCursor;
          if (!result.hasMore || !cursor) break;
        }
        const meetings = unique(kind === 'more' ? [...state.meetings, ...results] : results);
        pages = Math.max(1, Math.ceil(meetings.length / pageSize));
        update({ meetings: JSON.stringify(state.meetings) === JSON.stringify(meetings) ? state.meetings : meetings,
          nextCursor: result?.nextCursor || null, hasMore: Boolean(result?.hasMore && result.nextCursor), loaded: true, error: '' });
      } catch (error) {
        if (current() && !token.controller.signal.aborted) update({ error: error.message || '会议列表暂时无法加载，请重试。' });
      } finally {
        if (current()) { active = null; update({ loading: false, loadingMore: Boolean(queuedMore), refreshing: false }); }
      }
      return state;
    })();
    return token.promise;
  }
  function refresh(value = state.archived, { background = false } = {}) {
    setArchived(value);
    if (!active) return run('refresh');
    if (background) return active.promise;
    if (!queuedRefresh) {
      const expected = generation;
      queuedRefresh = active.promise.then(() => {
        if (generation !== expected) return state;
        queuedRefresh = null;
        return run('refresh');
      });
    }
    return queuedRefresh;
  }
  function loadMore() {
    if (queuedMore) return queuedMore;
    if (active) {
      if (active.kind === 'more') return active.promise;
      const expected = generation;
      queuedMore = active.promise.then(async () => {
        if (generation !== expected) return state;
        // A manual refresh may have been queued after this click. Let it update
        // the loaded range and cursor before appending the requested page.
        if (queuedRefresh) await queuedRefresh;
        if (generation !== expected) return state;
        queuedMore = null;
        update({ loadingMore: false });
        return loadMore();
      });
      update({ loadingMore: true });
      return queuedMore;
    }
    if (!state.loaded) return refresh();
    if (!state.hasMore) return Promise.resolve(state);
    return run('more');
  }
  return { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    setArchived, refresh, loadMore, cancel };
}

export function useMeetingList({ archived = false, pageSize = 20, pollMs = 4000 } = {}) {
  const [controller] = useState(() => createMeetingListController({ archived, pageSize }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.setArchived(archived);
    void controller.refresh();
    const timer = setInterval(() => { void controller.refresh(undefined, { background: true }); }, pollMs);
    return () => { clearInterval(timer); controller.cancel(); };
  }, [archived, controller, pollMs]);
  // Prop changes render before their effect can reset the controller. Never
  // expose the previous archive scope during that intermediate render.
  const visible = state.archived === Boolean(archived) ? state : { archived: Boolean(archived), meetings: [], loading: true,
    loadingMore: false, refreshing: false, error: '', hasMore: false, nextCursor: null, loaded: false };
  return { ...visible, refresh: controller.refresh, loadMore: controller.loadMore };
}
