import test from 'node:test';
import assert from 'node:assert/strict';
import { speechCharacterCount, isVoiceprintTextEligible, assessAutoMatch, assessSpeakerConsensus } from '../shared/voiceprint-policy.js';

test('voiceprint text gate counts Unicode letters and numbers but ignores punctuation, spaces and emoji', () => {
  for (const text of ['嗯。', '可以吧？！', '对 对 对', '👍👍👍👍', '。。。', '']) assert.equal(isVoiceprintTextEligible(text), false, text);
  for (const text of ['可以这样做。', 'A I 2 0', '这 是 好 的', '𠮷野家很好']) assert.equal(isVoiceprintTextEligible(text), true, text);
  assert.equal(speechCharacterCount('A，乙 2！👍'), 3);
});

const candidate = (memberId = 'a', score = 0.9) => ({ scope: 'team', memberId, score });
const evidence = () => ({ ranked: [candidate(), candidate('b', 0.6)], segmentMatches: ['one', 'two'].map(sourceId => ({ sourceId, candidates: [candidate(), candidate('b', 0.6)], margin: 0.3 })), consistency: 0.9 });

test('automatic naming requires two independent strong matches to the same team identity', () => {
  assert.equal(assessAutoMatch(evidence()).memberId, 'a');
  for (const mutate of [
    data => { data.segmentMatches.pop(); },
    data => { data.segmentMatches[1].sourceId = 'one'; },
    data => { data.segmentMatches[1].candidates[0] = candidate('b'); },
    data => { data.segmentMatches[1].candidates[0].score = 0.79; },
    data => { data.segmentMatches[1].margin = 0.14; },
    data => { data.segmentMatches[1].margin = NaN; },
    data => { data.segmentMatches[1].candidates[0].score = NaN; },
  ]) { const data = evidence(); mutate(data); assert.equal(assessAutoMatch(data), null); }
});

test('one enrolled member uses a neutral baseline, and meeting visitors never auto merge', () => {
  const one = evidence(); one.ranked = [candidate()];
  one.segmentMatches.forEach(segment => { segment.candidates = [candidate()]; segment.margin = 0.9; });
  assert.equal(assessAutoMatch(one).margin, 0.9);
  const visitor = { scope: 'meeting', participantId: 'guest', meetingId: 'first', score: 1 };
  assert.equal(assessAutoMatch({ ranked: [visitor], segmentMatches: ['one', 'two'].map(sourceId => ({ sourceId, candidates: [visitor], margin: 1 })), consistency: 1 }), null);
});

test('weak and ambiguous utterances abstain even when they dilute the whole-cluster aggregate', () => {
  const data = evidence();
  data.ranked = [candidate('b', 0.6), candidate('a', 0.55)];
  data.consistency = 0.2;
  data.segmentMatches.push(
    { sourceId: 'weak', candidates: [candidate('b', 0.7)], margin: 0.4 },
    { sourceId: 'ambiguous', candidates: [candidate('b', 0.9), candidate('a', 0.85)], margin: 0.05 },
  );
  const accepted = assessAutoMatch(data);
  assert.equal(accepted.memberId, 'a');
  assert.deepEqual(accepted.matchingSourceIds, ['one', 'two']);
  assert.equal(accepted.matchingSegmentCount, 2);
  assert.equal(accepted.evaluatedSegmentCount, 4);
  assert.equal(accepted.score, 0.9);
  assert.equal(accepted.scoreBasis, 'matching_segments');
});

test('one reliable conflicting identity blocks a majority instead of becoming a weak abstention', () => {
  const data = evidence();
  data.segmentMatches.push({ sourceId: 'third', candidates: [candidate('b')], margin: 0.3 });
  const decision = assessSpeakerConsensus(data);
  assert.equal(decision.autoAccept, null);
  assert.equal(decision.reason, 'conflicting_matches');
  assert.deepEqual(decision.matchingSourceIds, ['one', 'two', 'third']);
});

test('an excellent centroid cannot replace the second reliable utterance, and duplicate evidence cannot add votes', () => {
  const data = evidence(); data.ranked[0].score = 1;
  data.segmentMatches[1].candidates[0].score = 0.79;
  assert.equal(assessSpeakerConsensus(data).reason, 'insufficient_matches');
  data.segmentMatches[1] = { ...data.segmentMatches[0] };
  assert.equal(assessSpeakerConsensus(data).reason, 'invalid_evidence');
});

test('different registered profiles of one member count as one identity', () => {
  const data = evidence();
  data.segmentMatches[0].candidates[0].id = 'profile-first';
  data.segmentMatches[1].candidates[0].id = 'profile-second';
  assert.equal(assessAutoMatch(data).memberId, 'a');
});
