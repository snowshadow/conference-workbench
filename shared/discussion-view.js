export const isActiveFocus = item => item?.status === 'active' && !item.stale && !item.mergedInto && item.attention?.needed !== false;

// A useful retrospective can include a misunderstanding that the meeting resolved.
// Keep its factual status; being worth revisiting does not make it unresolved.
export const isReadingFocus = (item, meeting) => {
  if (meeting?.source !== 'recording_import') return isActiveFocus(item);
  if (item?.retrospective === true) return ['active', 'resolved', 'recorded'].includes(item.status) && !item.stale && !item.resolution?.stale && !item.mergedInto && item.attention?.needed !== false;
  if (meeting.retrospectiveAnalysis?.focusCompleted && item?.author === 'ai' && !item.manualFields?.length && item.resolution?.author !== 'host') return false;
  return isActiveFocus(item);
};

const PRIORITIES = {
  high: { level: 'high', rank: 3, label: '优先讨论' },
  medium: { level: 'medium', rank: 2, label: '随后讨论' },
  low: { level: 'low', rank: 1, label: '可以稍后' },
};

export function focusPriority(item, meeting) {
  const priority = !item?.priority?.stale && Object.hasOwn(PRIORITIES, item?.priority?.level) ? PRIORITIES[item.priority.level] : null;
  const label = meeting?.source === 'recording_import' ? { high: '优先回看', medium: '随后回看', low: '可以稍后' }[priority?.level] : priority?.label;
  return priority ? { ...priority, label, reason: typeof item.priority.reason === 'string' ? item.priority.reason.trim() : '' }
    : { level: 'unrated', rank: 0, label: '待排序', reason: '' };
}

// Three broad groups, stable within each group; no precision score or tie-break
// based on ASR segmentation. Legacy questions retain their existing order.
export function orderedFocuses(meeting) {
  return (meeting.followups || []).filter(item => isReadingFocus(item, meeting)).sort((a, b) => focusPriority(b).rank - focusPriority(a).rank);
}

// A reading session keeps its order. New questions enter when the host opens
// the list again; resolved/merged questions do not become dead navigation stops.
export function browseFocusIds(meeting, frozenIds) {
  if (!Array.isArray(frozenIds)) return orderedFocuses(meeting).map(item => item.id);
  return [...new Set(frozenIds.map(id => resolveFocus(meeting, id)).filter(item => isReadingFocus(item, meeting)).map(item => item.id))];
}

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
  const candidates = (index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)]).filter(item => isReadingFocus(item, meeting))
    .sort((a, b) => focusPriority(b).rank - focusPriority(a).rank);
  const topicId = items[index]?.topicId;
  const firstRank = focusPriority(candidates[0]).rank;
  const related = topicId && candidates.find(item => item.topicId === topicId && focusPriority(item).rank === firstRank);
  return related?.id || candidates[0]?.id || null;
}

export function recommendedFocusId(meeting) {
  if (meeting.source === 'recording_import') {
    const ordered = orderedFocuses(meeting);
    const chosen = resolveFocus(meeting, meeting.focusFollowupId);
    return isReadingFocus(chosen, meeting) && focusPriority(chosen).rank >= focusPriority(ordered[0]).rank ? chosen.id : ordered[0]?.id || null;
  }
  // An explicit empty recommendation means the meeting can continue quietly.
  if (Object.hasOwn(meeting, 'focusFollowupId')) {
    if (meeting.focusFollowupId === null) return null;
    const item = resolveFocus(meeting, meeting.focusFollowupId);
    if (isActiveFocus(item)) {
      const first = orderedFocuses(meeting)[0];
      return first && focusPriority(first).rank > focusPriority(item).rank ? first.id : item.id;
    }
    // A saved note can leave the main focus without declaring the question
    // resolved. Only known handled items advance; missing or stale sources wait.
    if (!item || item.stale || !['recorded', 'resolved', 'ignored'].includes(item.status) && item.attention?.needed !== false) return null;
    return nextFocusId(meeting, item.id);
  }
  return orderedFocuses(meeting)[0]?.id || null;
}

export function readingFocusId(meeting, selected, following = true, paused = false) {
  const item = resolveFocus(meeting, selected);
  if (!following || paused) return item?.id || null;
  return isReadingFocus(item, meeting) ? item.id : recommendedFocusId(meeting);
}

export function returnFocusId(meeting, readingId) {
  const recommendation = recommendedFocusId(meeting);
  return recommendation && recommendation !== resolveFocus(meeting, readingId)?.id ? recommendation : null;
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
