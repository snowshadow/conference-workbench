import test from 'node:test';
import assert from 'node:assert/strict';
import { clarificationShareContent, clarificationShareFilename, wrapShareText } from '../src/lib/clarification-share.js';

const meeting = { title: '方案讨论', transcriptRevision: 8 };
const question = {
  question: '完整问题', shortQuestion: '分享时的问题', sourceRevision: 8,
  rationale: '讨论背景', impact: '影响接口约定',
  clarification: { explanation: 'AI 对讨论的解释', distinctions: [{ title: '端侧维护', text: '端侧负责状态。', example: '原话示例' }, { title: '云端维护', text: '云端负责状态。' }] },
};

test('share preserves the displayed question, context, distinctions and examples', () => {
  const content = clarificationShareContent(question, meeting);
  assert.equal(content.question, '分享时的问题');
  assert.equal(content.reason, '讨论背景');
  assert.deepEqual(content.distinctions, [{ title: '端侧维护', text: '端侧负责状态。', example: '原话示例' }, { title: '云端维护', text: '云端负责状态。', example: '' }]);
  assert.equal(content.explanation, '');
  assert.equal(content.impact, '');
  const expanded = clarificationShareContent(question, meeting, { includeExplanation: true });
  assert.equal(expanded.explanation, question.clarification.explanation);
  assert.equal(expanded.impact, question.impact);
});

test('manual context wins and stale interpretations are not exported', () => {
  const item = { ...question, stale: true, manualFields: ['discussionValue'], discussionValue: '主持人修正的背景', clarification: { ...question.clarification, stale: true } };
  const content = clarificationShareContent(item, meeting, { includeExplanation: true });
  assert.equal(content.question, '完整问题');
  assert.equal(content.reason, '主持人修正的背景');
  assert.equal(content.explanation, '');
  assert.deepEqual(content.distinctions, []);
  assert.match(content.footer, /原文已修改，内容待核对/);
});

test('omit stale and incomplete distinction cards, mark later speech awaiting review', () => {
  const item = { ...question, clarification: { distinctions: [...question.clarification.distinctions, { title: '旧解释', text: '不可分享', stale: true }, { title: '没有正文' }] } };
  const content = clarificationShareContent(item, { ...meeting, transcriptRevision: 9 });
  assert.equal(content.distinctions.length, 2);
  assert.match(content.footer, /有新发言，待复核/);
});

test('retain recorded outcomes with their actual provenance when sharing', () => {
  const item = { ...question, resolution: { text: '会上已明确边界', author: 'ai', sourceRevision: 8 } };
  assert.equal(clarificationShareContent(item, meeting).resolution, '');
  const content = clarificationShareContent(item, { ...meeting, source: 'recording_import' }, { includeResolution: true });
  assert.equal(content.resolution, '会上已明确边界');
  assert.equal(content.resolutionLabel, '会上最后说到');
  assert.equal(content.footer, '方案讨论 · 复盘焦点');
});

test('legacy questions still export their available context', () => {
  const content = clarificationShareContent({ question: '一个问题？', impact: '为什么要问' }, meeting, { includeExplanation: true });
  assert.equal(content.reason, '为什么要问');
  assert.equal(content.impact, '');
  assert.deepEqual(content.distinctions, []);
});

test('filename is safe for downloads and bounded even for emoji titles', () => {
  const filename = clarificationShareFilename({ question: '👩‍💻问题/<>:*?'.repeat(80) }, { title: '会议/<>:*?'.repeat(80) });
  assert.ok(Buffer.byteLength(filename) < 255);
  assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(filename.endsWith('.png'));
});

const measure = value => [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].length;
test('long mixed text wraps without truncation and preserves paragraph breaks and emoji', () => {
  const text = '端上状态 gateway ActionController 超长标识符ABCDEFGHIJKLMN 👩‍💻\n\n下一段不能丢失。';
  const lines = wrapShareText(text, 8, measure);
  assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(lines.includes(''));
  assert.ok(lines.every(line => measure(line) <= 8));
  assert.ok(lines.some(line => line.includes('👩‍💻')));
});

test('Chinese closing punctuation does not begin a wrapped line', () => {
  const text = '这句话用来测试，标点不能丢失。';
  const lines = wrapShareText(text, 7, measure);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => !/^[，。]/.test(line)));
  assert.ok(lines.every(line => measure(line) <= 7));
});

test('opening punctuation carried onto a full-width final word never clips it', () => {
  const text = '前缀（abcdefgh';
  const lines = wrapShareText(text, 8, measure);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => measure(line) <= 8));
});
