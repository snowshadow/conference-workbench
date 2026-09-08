import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAsrResult } from '../server/capture/protocol.js';

const line = utterance => normalizeAsrResult({ result: { utterances: [utterance] } }).utterances[0];

test('real ASR response with an omitted sentence start uses the first word timestamp', () => {
  // Reduced from a live response to synthetic test speech, without request IDs.
  const text = '这是会议工作台的实时转录测试，我们先对齐概念，再讨论方案，最后依据也应该完整保存。';
  const result = normalizeAsrResult({ audio_info: { duration: 9089 }, result: {
    text,
    utterances: [{
      text, definite: true, end_time: 9082,
      additions: { source: 'two_pass', speaker_id: '0' },
      words: [{ text: '这', start_time: 40, end_time: 200 },
        { text: '是', start_time: 200, end_time: 360 },
        { text: '存', start_time: 8640, end_time: 8880 }],
    }],
  } });
  assert.deepEqual(result, { text, utterances: [{ text, definite: true, startTime: 40, endTime: 9082, speaker: '0' }] });
});

test('explicit sentence timestamps take priority and preserve a zero start', () => {
  const result = line({ text: '句级时间', start_time: 0, end_time: 1000,
    words: [{ start_time: 40, end_time: 900 }],
  });
  assert.equal(result.startTime, 0);
  assert.equal(result.endTime, 1000);
});

test('missing sentence boundaries use only explicit first and last word boundaries', () => {
  const result = line({ text: '词级时间', words: [
    { start_time: 0, end_time: 200 }, { start_time: 200, end_time: 600 }, { start_time: 600, end_time: 900 },
  ] });
  assert.equal(result.startTime, 0);
  assert.equal(result.endTime, 900);

  const incomplete = line({ text: '首尾时间未知', words: [
    { end_time: 200 }, { start_time: 200, end_time: 600 }, { start_time: 600 },
  ] });
  assert.equal(incomplete.startTime, undefined, 'an interior word cannot establish the beginning');
  assert.equal(incomplete.endTime, undefined, 'an interior word cannot establish the end');
});

test('missing, negative, textual or non-finite timestamps do not become invented audio positions', () => {
  for (const value of [undefined, null, -1, '0', '40', NaN, Infinity, -Infinity]) {
    const result = line({ text: '无可靠时间', start_time: value, end_time: value,
      words: [{ start_time: value, end_time: value }],
    });
    assert.equal(result.startTime, undefined);
    assert.equal(result.endTime, undefined);
  }
  assert.equal(line({ text: '没有词级依据' }).startTime, undefined);
  assert.equal(line({ text: '没有词级依据' }).endTime, undefined);
});

test('numeric speaker zero survives field priority and empty speaker fields still fall back', () => {
  assert.equal(line({ speaker: 0, speaker_id: 'other' }).speaker, 0);
  assert.equal(line({ speaker: '', speaker_id: 0, additions: { speaker_id: 'other' } }).speaker, 0);
  assert.equal(line({ speaker: '', additions: { speaker: '', speaker_id: 0 } }).speaker, 0);
  assert.equal(line({ speaker: '', speaker_id: '', additions: { speaker_id: '2' } }).speaker, '2');
  assert.equal(line({}).speaker, '');
});
