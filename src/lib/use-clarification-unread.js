import { useEffect, useState } from 'react';
import { updateClarificationUnread } from '../../shared/clarification-unread.js';

export function useClarificationUnread(meeting, discussionView) {
  const [sessions, setSessions] = useState(() => new Map());
  const current = updateClarificationUnread(sessions, meeting, discussionView);
  useEffect(() => {
    setSessions(previous => updateClarificationUnread(previous, meeting, discussionView));
  }, [meeting, discussionView]);
  return current.get(meeting?.id)?.unreadIds.size || 0;
}

