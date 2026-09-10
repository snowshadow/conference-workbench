// Trial thresholds, deliberately conservative until checked on this team's rooms/devices.
export const VOICEPRINT_POLICY = Object.freeze({
  version: 'campplus-trial-2', calibrated: false, minCharacters: 4,
  minSegments: 2, maxSegments: 4, minSegmentSeconds: 3, maxSegmentSeconds: 30, minTotalSeconds: 6,
  minimumCosine: 0.8, minimumMargin: 0.15, minimumConsistency: 0.7,
  candidateMinimumCosine: 0.5, candidateMinimumMargin: 0.08,
});

export const speechCharacterCount = text => (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
export const isVoiceprintTextEligible = text => speechCharacterCount(text) >= VOICEPRINT_POLICY.minCharacters;
export const voiceprintIdentityKey = candidate => candidate?.scope === 'team' && candidate.memberId
  ? `team:${candidate.memberId}` : candidate?.scope === 'meeting' && candidate.participantId
    ? `meeting:${candidate.meetingId}:${candidate.participantId}` : null;

export function assessAutoMatch({ ranked = [], segmentMatches = [], consistency = 0 }, policy = VOICEPRINT_POLICY) {
  const best = ranked[0], identity = voiceprintIdentityKey(best);
  if (!identity || best.scope !== 'team' || segmentMatches.length < policy.minSegments || !Number.isFinite(consistency) || consistency < policy.minimumConsistency) return null;
  // With only one enrolled identity, compare to the neutral cosine baseline rather than inventing a runner-up.
  const margin = best.score - (ranked[1]?.score ?? 0);
  if (!Number.isFinite(best.score) || !Number.isFinite(margin) || best.score < policy.minimumCosine || margin < policy.minimumMargin) return null;
  const sourceIds = new Set();
  for (const segment of segmentMatches) {
    const first = segment.candidates?.[0];
    if (!segment.sourceId || sourceIds.has(segment.sourceId) || voiceprintIdentityKey(first) !== identity || !Number.isFinite(first.score) || !Number.isFinite(segment.margin) || first.score < policy.minimumCosine || segment.margin < policy.minimumMargin) return null;
    sourceIds.add(segment.sourceId);
  }
  return { ...best, margin, consistency, policyVersion: policy.version, calibrated: false };
}
