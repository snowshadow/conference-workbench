// Question review and record review are independent: a new utterance can keep
// a question open without invalidating what the host or Agent has saved.
export function clarificationRecordReview(item) {
  const resolution = item?.resolution;
  if (!resolution) return null;
  if (resolution.stale) return 'source_changed';
  // Only a model result produced against an older snapshot needs its own
  // follow-up check. Manual records do not claim to cover all later speech.
  if (resolution.author === 'ai' && resolution.pendingReview) return 'newer_speech';
  return null;
}
