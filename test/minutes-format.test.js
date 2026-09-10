import test from 'node:test';
import assert from 'node:assert/strict';
import { minutesDocumentMarkdown } from '../shared/minutes-format.js';

const document = (markdown, overrides = {}) => ({ type: 'minutes', author: 'ai', markdown, ...overrides });

test('historical minutes show one topic heading while retaining every distinct point and source', () => {
  const points = [
    '画像与记忆分开存储。 [08:00](#transcript:source-1) [09:00](#transcript:source-2)',
    '画像是记忆的子集，两者共享标签树。 [124:00](#transcript:source-3)',
    '更新画像时，中长期状态不能割裂。 [128:00](#transcript:source-4)',
  ];
  const markdown = ['# 记忆方案讨论', '', '已整理的转录版本：18', '', '## 讨论要点', '', ...points.map(point => `- **画像与记忆的区别和关系**：${point}`), ''].join('\n');
  const artifact = document(markdown, { sourceRevision: 18, stale: true, updatedAt: '2026-09-08T03:39:00Z' });
  const before = structuredClone(artifact);

  const formatted = minutesDocumentMarkdown(artifact);

  assert.equal(formatted, ['# 记忆方案讨论', '', '## 讨论要点', '', '### 画像与记忆的区别和关系', '', ...points.map(point => `- ${point}`), ''].join('\n'));
  assert.equal((formatted.match(/#transcript:/g) || []).length, 4);
  assert.deepEqual(artifact, before, 'formatting does not rewrite the saved artifact or its historical provenance');
});

test('returning to an earlier topic preserves discussion order instead of regrouping across another topic', () => {
  const formatted = minutesDocumentMarkdown(document([
    '## 讨论要点', '',
    '- **A**：先讨论 A。 [01:00](#transcript:a1)',
    '- **A**：补充 A 的约束。 [02:00](#transcript:a2)',
    '- **B**：转向 B。 [03:00](#transcript:b1)',
    '- **A**：随后回到 A。 [04:00](#transcript:a3)',
  ].join('\n')));

  assert.deepEqual(formatted.match(/^### .+$/gm), ['### A', '### B', '### A']);
  assert.deepEqual(formatted.match(/#transcript:[^)]+/g), ['#transcript:a1', '#transcript:a2', '#transcript:b1', '#transcript:a3']);
});

test('decision assumptions remain nested under their original decision with every source intact', () => {
  const assumption = '  - 相关前提（AI 按原文整理；前提仍待验证）：十个家庭同时在线还需验证。 [02:00](#transcript:capacity)';
  const formatted = minutesDocumentMarkdown(document([
    '## 决定', '',
    '- **同步方案**：先采用刷新方案。 [01:00](#transcript:decision)',
    assumption,
    '    验证完成前不扩大使用范围。',
    '- **同步方案**：保留人工刷新入口。 [03:00](#transcript:fallback)',
    '', '## 行动项', '',
    '- **同步方案**：下周验证并发。（负责人：小李） [04:00](#transcript:owner)',
  ].join('\n')));

  assert.ok(formatted.includes(`- 先采用刷新方案。 [01:00](#transcript:decision)\n${assumption}\n    验证完成前不扩大使用范围。\n- 保留人工刷新入口。 [03:00](#transcript:fallback)`));
  assert.ok(formatted.includes('## 行动项\n\n### 同步方案\n\n- 下周验证并发。（负责人：小李） [04:00](#transcript:owner)'));
  assert.deepEqual(formatted.match(/#transcript:[^)]+/g), ['#transcript:decision', '#transcript:capacity', '#transcript:fallback', '#transcript:owner']);
});

test('already grouped minutes stay identical through repeated formatting', () => {
  const grouped = ['# 纪要', '', '## 决定', '', '### 同步方案', '', '- 采用刷新方案。 [01:00](#transcript:one)', '  - 相关前提：并发仍待验证。', '', '## 讨论要点', '', '### 缓存', '', '- 保留用户主动刷新入口。', ''].join('\n');
  assert.equal(minutesDocumentMarkdown(document(grouped)), grouped);

  const once = minutesDocumentMarkdown(document('## 未决问题\n\n- **缓存**：离线后如何恢复？ [02:00](#transcript:two)\n'));
  assert.equal(minutesDocumentMarkdown(document(once)), once);
});

test('host and agent documents, and artifacts other than minutes, preserve authored Markdown byte for byte', () => {
  const markdown = '## 讨论要点\r\n\r\n- **主题**：第一条。 [01:00](#transcript:first)\r\n- **主题**：第二条。  \r\n';
  for (const overrides of [
    { author: 'host' },
    { author: 'agent' },
    { author: 'host', type: 'minutes-draft' },
    { author: 'agent', type: 'minutes-draft-2' },
    { type: 'decision-log' },
    { type: 'minutes-review' },
    { type: 'minutes-draft-final' },
  ]) assert.equal(minutesDocumentMarkdown(document(markdown, overrides)), markdown, JSON.stringify(overrides));
});

test('AI minutes drafts share the same grouping as the current minutes', () => {
  const markdown = '## 未决问题\n\n- **缓存**：离线后如何恢复？';
  const expected = '## 未决问题\n\n### 缓存\n\n- 离线后如何恢复？';
  for (const type of ['minutes', 'minutes-draft', 'minutes-draft-2']) assert.equal(minutesDocumentMarkdown(document(markdown, { type })), expected);
});

test('clarification sections and nested custom sections are not interpreted as generated discussion entries', () => {
  const markdown = ['## 已澄清口径', '', '- **实时是什么意思？**：下次打开可见。', '', '## 待验证前提', '', '- **并发**：尚未验证。', '', '## 尚待澄清', '', '- **离线**：需要继续讨论。', '', '## 讨论要点', '', '### 主持人的示例', '', '- **保留这一格式**：这是嵌套章节中的写法。', ''].join('\n');
  assert.equal(minutesDocumentMarkdown(document(markdown)), markdown.replace('## 已澄清口径', '## 已经说清楚').replace('## 待验证前提', '## 还需要验证'));
});

test('historical AI resolution headings use plain language without rewriting quoted, nested or authored content', () => {
  const unchanged = [
    '- 原话提到「已澄清口径」「待验证前提」「仍有分歧或取舍」。 [01:00](#transcript:original)',
    '> ## 已澄清口径',
    '### 待验证前提',
    '  ## 仍有分歧或取舍',
    '```markdown\n## 已澄清口径\n```',
    '~~~markdown\n## 待验证前提\n~~~',
    '````markdown\n```\n## 仍有分歧或取舍\n```\n````',
    '## 讨论记录',
    '## 尚待澄清',
  ].join('\n\n');
  const markdown = ['## 已澄清口径', '## 待验证前提', '## 仍有分歧或取舍', unchanged, ''].join('\n\n');
  const expected = ['## 已经说清楚', '## 还需要验证', '## 还有不同意见', unchanged, ''].join('\n\n');

  for (const type of ['minutes', 'minutes-draft', 'minutes-draft-2']) {
    const artifact = document(markdown, { type, stale: true, sourceRevision: 8 });
    const before = structuredClone(artifact);
    const formatted = minutesDocumentMarkdown(artifact);
    assert.equal(formatted, expected);
    assert.equal(minutesDocumentMarkdown({ ...artifact, markdown: formatted }), formatted);
    assert.deepEqual(artifact, before, 'historical artifacts and provenance are not mutated');
    for (const author of ['host', 'agent']) assert.equal(minutesDocumentMarkdown({ ...artifact, author }), markdown);
  }
  assert.equal(minutesDocumentMarkdown(document(markdown, { type: 'decision-log' })), markdown);
});

test('Markdown examples inside backtick or tilde code fences remain untouched', () => {
  const examples = [
    '```markdown\n## 决定\n- **示例**：这不是会议决定。\n```',
    '~~~markdown\n## 讨论要点\n- **示例**：这不是讨论条目。\n~~~',
    '````markdown\n```\n## 行动项\n- **示例**：内部短围栏不结束代码块。\n```\n````',
  ];
  const markdown = ['## 讨论要点', '', ...examples, '', '- **缓存**：实际讨论保留缓存。 [05:00](#transcript:actual)', ''].join('\n');
  const formatted = minutesDocumentMarkdown(document(markdown));
  for (const example of examples) assert.ok(formatted.includes(example), 'code examples are preserved exactly');
  assert.ok(formatted.includes('### 缓存\n\n- 实际讨论保留缓存。 [05:00](#transcript:actual)'));
});

test('formatting a Windows Markdown document preserves CRLF line endings and its trailing newline', () => {
  const markdown = ['## 讨论要点', '', '- **缓存**：保留缓存。', '- **缓存**：允许刷新。', ''].join('\r\n');
  const expected = ['## 讨论要点', '', '### 缓存', '', '- 保留缓存。', '- 允许刷新。', ''].join('\r\n');
  const formatted = minutesDocumentMarkdown(document(markdown));
  assert.equal(formatted, expected);
  assert.doesNotMatch(formatted, /(?<!\r)\n/);
});

test('generated metadata hides internal revision numbers while retaining time, authors and transcript links', () => {
  const markdown = [
    '# 产品讨论', '', '已整理的转录版本：854 · 生成时间：2026-09-09T09:30:00.000Z', '',
    '## 讨论记录', '',
    '- **1.0 是否支持多个角色？**（主持人记录；未标记为已解决；依据版本 697；未关联原文）',
    '  保留多角色能力，1.0 先聚焦一部分角色。', '',
    '## 还需要验证', '',
    '- **响应时间够快吗？**（Agent 记录；依据版本 830）',
    '  等实际测试结果。 [10:00](#transcript:latency)', '',
    '## 尚待澄清', '',
    '- **哪些入口属于本次发布？**（AI 按原文整理；已有部分进展，问题尚未解决；依据版本 854）',
    '  App 范围仍待说明。 [15:00](#transcript:scope)', '',
  ].join('\r\n');
  const expected = markdown.replace('已整理的转录版本：854 · ', '').replace('；依据版本 697', '').replace('；依据版本 830', '').replace('；依据版本 854', '');
  for (const type of ['minutes', 'minutes-draft', 'minutes-draft-2']) {
    const artifact = document(markdown, { type, sourceRevision: 854, stale: true });
    const before = structuredClone(artifact);
    const formatted = minutesDocumentMarkdown(artifact);
    assert.equal(formatted, expected);
    assert.deepEqual(artifact, before);
    assert.equal(minutesDocumentMarkdown({ ...artifact, markdown: formatted }), formatted);
    for (const author of ['host', 'agent']) assert.equal(minutesDocumentMarkdown({ ...artifact, author }), markdown);
  }
});

test('revision wording in meeting content, quotes and code remains untouched', () => {
  const record = '- **依据版本 3 的测试结果可靠吗？**（AI 按原文整理；依据版本 20）';
  const markdown = [
    '# 版本讨论', '', '## 讨论要点', '',
    '已整理的转录版本：18 · 生成时间：这是原文举例，不是文档元数据。',
    '我们讨论过“依据版本 3”代表什么。 [01:00](#transcript:version)',
    '`已整理的转录版本：18 · 生成时间：示例`',
    '## 讨论记录', '',
    '> 已整理的转录版本：18',
    `> ${record}`,
    `    ${record}`,
    '  正文提到“；依据版本 20”的写法。',
    '```markdown', record, '已整理的转录版本：18 · 生成时间：示例', '```',
    '~~~markdown', record, '~~~',
    '````markdown', '```', record, '```', '````',
    '### 正文示例', record, '',
  ].join('\n');
  assert.equal(minutesDocumentMarkdown(document(markdown)), markdown);
});

test('old resolution section names retain record text and references when system revisions are hidden', () => {
  const markdown = [
    '# 旧纪要', '', '已整理的转录版本：18', '',
    '## 已澄清口径', '',
    '- **“依据版本 3”是什么意思？**（AI 按原文整理；依据版本 18）',
    '  指当次测试的输入版本。 [01:00](#transcript:original)', '',
  ].join('\n');
  const expected = markdown.replace('已整理的转录版本：18\n\n', '').replace('## 已澄清口径', '## 已经说清楚').replace('；依据版本 18', '');
  assert.equal(minutesDocumentMarkdown(document(markdown)), expected);
});
