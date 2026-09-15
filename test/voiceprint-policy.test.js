import test from 'node:test';
import assert from 'node:assert/strict';
import { speechCharacterCount, isVoiceprintTextEligible, assessAutoMatch } from '../shared/voiceprint-policy.js';

test('voiceprint text gate counts Unicode letters and numbers but ignores punctuation, spaces and emoji', () => {
  for (const text of ['嗯。', '可以吧？！', '对 对 对', '👍👍👍👍', '。。。', '']) assert.equal(isVoiceprintTextEligible(text), false, text);
  for (const text of ['可以这样做。', 'A I 2 0', '这 是 好 的', '𠮷野家很好']) assert.equal(isVoiceprintTextEligible(text), true, text);
  assert.equal(speechCharacterCount('A，乙 2！👍'), 3);
});

const candidate = (memberId = 'a', score = 0.9) => ({ scope: 'team', memberId, score });
const evidence = () => ({ ranked: [candidate(), candidate('b', 0.6)], segmentMatches: ['one', 'two'].map(sourceId => ({ sourceId, candidates: [candidate(), candidate('b', 0.6)], margin: 0.3 })), consistency: 0.9 });

test('automatic naming requires two independent consistent segment identities with strong scores and margins', () => {
  assert.equal(assessAutoMatch(evidence()).memberId, 'a');
  for (const mutate of [
    data => { data.segmentMatches.pop(); },
    data => { data.segmentMatches[1].sourceId = 'one'; },
    data => { data.segmentMatches[1].candidates[0] = candidate('b'); },
    data => { data.segmentMatches[1].candidates[0].score = 0.79; },
    data => { data.segmentMatches[1].margin = 0.14; },
    data => { data.ranked[0].score = 0.79; },
    data => { data.ranked[1].score = 0.79; },
    data => { data.consistency = 0.69; },
    data => { data.consistency = NaN; },
    data => { data.segmentMatches[1].margin = NaN; },
  ]) { const data = evidence(); mutate(data); assert.equal(assessAutoMatch(data), null); }
});

test('one enrolled member uses a neutral baseline, and meeting visitors never auto merge', () => {
  const one = evidence(); one.ranked = [candidate()];
  assert.equal(assessAutoMatch(one).margin, 0.9);
  const visitor = { scope: 'meeting', participantId: 'guest', meetingId: 'first', score: 1 };
  assert.equal(assessAutoMatch({ ranked: [visitor], segmentMatches: ['one', 'two'].map(sourceId => ({ sourceId, candidates: [visitor], margin: 1 })), consistency: 1 }), null);
});
