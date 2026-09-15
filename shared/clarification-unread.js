import { isReadingFocus } from './discussion-view.js';

const sameIds = (first, second) => first.size === second.size && [...first].every(id => second.has(id));

// This is navigation state for the current browser session, not meeting data.
// Keep encountered IDs so a wording change or a restored old question is not
// announced again as a newly created focus.
export function updateClarificationUnread(state, meeting, view) {
  if (!meeting?.id) return state;
  const followups = (meeting.followups || []).filter(item => typeof item?.id === 'string' && item.id);
  const currentIds = new Set(followups.map(item => item.id));
  const activeIds = new Set(followups.filter(item => isReadingFocus(item, meeting)).map(item => item.id));
  const previous = state.get(meeting.id);
  const knownIds = new Set(previous?.knownIds || currentIds);
  const unreadIds = new Set();

  if (previous && view === 'topics') {
    for (const id of activeIds) {
      if (previous.unreadIds.has(id) || !knownIds.has(id)) unreadIds.add(id);
    }
  }
  for (const id of currentIds) knownIds.add(id);
  if (previous && sameIds(knownIds, previous.knownIds) && sameIds(unreadIds, previous.unreadIds)) return state;
  return new Map(state).set(meeting.id, { knownIds, unreadIds });
}
