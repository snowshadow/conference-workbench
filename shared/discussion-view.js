export const isActiveFocus = item => item?.status === 'active' && !item.stale && !item.mergedInto;

export function resolveFocus(meeting, id) {
  const seen = new Set();
  let item = (meeting.followups || []).find(followup => followup.id === id);
  while (item?.mergedInto) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    item = (meeting.followups || []).find(followup => followup.id === item.mergedInto);
  }
  return item || null;
}

export function nextFocusId(meeting, currentId) {
  const items = meeting.followups || [];
  const index = items.findIndex(item => item.id === currentId);
  const candidates = (index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)]).filter(isActiveFocus);
  const topicId = items[index]?.topicId;
  const related = topicId && candidates.find(item => item.topicId === topicId);
  return related?.id || candidates[0]?.id || null;
}

export function recommendedFocusId(meeting) {
  // An explicit empty recommendation means the meeting can continue quietly.
  if (Object.hasOwn(meeting, 'focusFollowupId')) {
    if (meeting.focusFollowupId === null) return null;
    const item = resolveFocus(meeting, meeting.focusFollowupId);
    if (isActiveFocus(item)) return item.id;
    // Host actions can finish a question without another model run. Continue
    // locally only from a known finished item; missing or stale sources wait.
    if (!item || item.stale || !['resolved', 'ignored'].includes(item.status)) return null;
    return nextFocusId(meeting, item.id);
  }
  return (meeting.followups || []).find(isActiveFocus)?.id || null;
}

export function readingFocusId(meeting, selected, following = true, paused = false) {
  return following && !paused ? recommendedFocusId(meeting) : resolveFocus(meeting, selected)?.id || null;
}

export const isCurrentEntry = entry => !entry.stale && entry.status !== 'superseded' && !(entry.type === 'question' && entry.status === 'resolved');

export function topicReadingEntries(entries = [], limit = 5) {
  const current = entries.filter(isCurrentEntry);
  // Keep decisions and actions visible even when there are more than five.
  const important = current.filter(entry => ['decision', 'action'].includes(entry.type));
  const others = current.filter(entry => !['decision', 'action'].includes(entry.type));
  const visibleIds = new Set([...important, ...others.slice(0, Math.max(0, limit - important.length))].map(entry => entry.id));
  return {
    visible: current.filter(entry => visibleIds.has(entry.id)),
    more: current.filter(entry => !visibleIds.has(entry.id)),
    history: entries.filter(entry => !isCurrentEntry(entry)),
  };
}
