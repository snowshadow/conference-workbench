import { resolutionOutcomes } from './resolution-copy.js';

const entrySections = new Set(['决定', '行动项', '未决问题', '讨论要点']);
const legacyResolutionHeadings = new Map([
  ['## 已澄清口径', `## ${resolutionOutcomes.clarified.label}`],
  ['## 待验证前提', `## ${resolutionOutcomes.needs_verification.label}`],
  ['## 仍有分歧或取舍', `## ${resolutionOutcomes.difference_remains.label}`],
]);
const resolutionSections = new Set(['讨论记录', '尚待澄清', ...Object.values(resolutionOutcomes).map(outcome => outcome.label), ...[...legacyResolutionHeadings.keys()].map(heading => heading.slice(3))]);

// Older generated minutes repeat the topic before every entry. Reformat that
// template without rebuilding historical content from today's discussion data.
export function minutesDocumentMarkdown(artifact) {
  const markdown = artifact?.markdown || '';
  if (artifact?.author !== 'ai' || !/^minutes(?:-draft(?:-\d+)?)?$/.test(artifact.type || '')) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const output = [];
  let entrySection = false, resolutionSection = false, topic = null, fence = null;
  for (const [index, originalLine] of lines.entries()) {
    let line = originalLine;
    const fenceLine = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      output.push(line);
      continue;
    }
    if (fenceLine) { fence = fenceLine[1]; topic = null; output.push(line); continue; }
    // These are generated metadata, not content to be rewritten throughout the
    // document. Limit the header match to the template's opening title block.
    const metadata = index === 2 && /^# .+/.test(lines[0]) && lines[1] === '' && line.match(/^已整理的转录版本：\d+(?: · (生成时间：.+))?$/);
    if (metadata) {
      if (metadata[1]) line = metadata[1];
      else { output.pop(); continue; }
    }
    if (/^#{1,6} /.test(line)) {
      entrySection = entrySections.has(line.match(/^## (.+)$/)?.[1]);
      resolutionSection = resolutionSections.has(line.match(/^## (.+)$/)?.[1]);
      topic = null;
    }
    if (resolutionSection) line = line.replace(/^(- \*\*.*\*\*（(?:主持人记录|Agent 记录|AI 按原文整理)(?:；已有部分进展，问题尚未解决)?(?:；未标记为已解决)?)；依据版本 \d+(；未关联原文)?）$/, '$1$2）');
    const entry = entrySection && line.match(/^- \*\*(.+?)\*\*：(.+)$/);
    if (entry) {
      if (topic !== entry[1]) {
        if (output.length && output.at(-1) !== '') output.push('');
        output.push(`### ${entry[1]}`, '');
        topic = entry[1];
      }
      output.push(`- ${entry[2]}`);
    } else {
      output.push(legacyResolutionHeadings.get(line) ?? line);
      if (line && !/^\s/.test(line)) topic = null;
    }
  }
  return output.join(newline);
}
