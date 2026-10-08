// Trial thresholds, deliberately conservative until checked on this team's rooms/devices.
export const VOICEPRINT_POLICY = Object.freeze({
  version: 'campplus-consensus-1', calibrated: false, minCharacters: 4,
  minSegments: 2, maxSegments: 4, minSegmentSeconds: 3, maxSegmentSeconds: 30, minTotalSeconds: 6,
  minimumCosine: 0.8, minimumMargin: 0.15,
  candidateMinimumCosine: 0.5, candidateMinimumMargin: 0.08,
});

export const speechCharacterCount = text => (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
export const isVoiceprintTextEligible = text => speechCharacterCount(text) >= VOICEPRINT_POLICY.minCharacters;
export const voiceprintIdentityKey = candidate => candidate?.scope === 'team' && candidate.memberId
  ? `team:${candidate.memberId}` : candidate?.scope === 'meeting' && candidate.participantId
    ? `meeting:${candidate.meetingId}:${candidate.participantId}` : null;

export function assessSpeakerConsensus({ segmentMatches = [] }, policy = VOICEPRINT_POLICY) {
  const sourceIds = new Set(), matches = [];
  for (const segment of segmentMatches) {
    const first = segment.candidates?.[0];
    if (!segment.sourceId || sourceIds.has(segment.sourceId)) return { autoAccept: null, reason: 'invalid_evidence', matchingSourceIds: [] };
    sourceIds.add(segment.sourceId);
    if (voiceprintIdentityKey(first) && Number.isFinite(first.score) && Number.isFinite(segment.margin) && first.score >= policy.minimumCosine && segment.margin >= policy.minimumMargin) matches.push(segment);
  }
  const identities = new Set(matches.map(segment => voiceprintIdentityKey(segment.candidates[0])));
  const matchingSourceIds = matches.map(segment => segment.sourceId);
  // ASR supplies the cluster. A weak utterance abstains; a strong match to a
  // different person is a conflict even if the majority agrees on one person.
  if (identities.size > 1) return { autoAccept: null, reason: 'conflicting_matches', matchingSourceIds };
  if (matches.length < policy.minSegments) return { autoAccept: null, reason: 'insufficient_matches', matchingSourceIds };
  const best = matches[0].candidates[0];
  if (best.scope !== 'team') return { autoAccept: null, reason: 'meeting_candidate', matchingSourceIds };
  const autoAccept = {
    ...best, score: matches.reduce((sum, segment) => sum + segment.candidates[0].score, 0) / matches.length,
    margin: Math.min(...matches.map(segment => segment.margin)), scoreBasis: 'matching_segments',
    matchingSourceIds, matchingSegmentCount: matches.length, evaluatedSegmentCount: segmentMatches.length,
    policyVersion: policy.version, calibrated: false,
  };
  return { autoAccept, reason: null, matchingSourceIds };
}

export const assessAutoMatch = (evidence, policy = VOICEPRINT_POLICY) => assessSpeakerConsensus(evidence, policy).autoAccept;
