import { resolutionOutcomes } from './resolution-copy.js';

const entrySections = new Set(['决定', '行动项', '未决问题', '讨论要点']);
const legacyResolutionHeadings = new Map([
  ['## 已澄清口径', `## ${resolutionOutcomes.clarified.label}`],
  ['## 待验证前提', `## ${resolutionOutcomes.needs_verification.label}`],
  ['## 仍有分歧或取舍', `## ${resolutionOutcomes.difference_remains.label}`],
]);

// Older generated minutes repeat the topic before every entry. Reformat that
// template without rebuilding historical content from today's discussion data.
export function minutesDocumentMarkdown(artifact) {
  const markdown = artifact?.markdown || '';
  if (artifact?.author !== 'ai' || !/^minutes(?:-draft(?:-\d+)?)?$/.test(artifact.type || '')) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const output = [];
  let entrySection = false, topic = null, fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceLine = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      output.push(line);
      continue;
    }
    if (fenceLine) { fence = fenceLine[1]; topic = null; output.push(line); continue; }
    if (/^#{1,6} /.test(line)) {
      entrySection = entrySections.has(line.match(/^## (.+)$/)?.[1]);
      topic = null;
    }
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
