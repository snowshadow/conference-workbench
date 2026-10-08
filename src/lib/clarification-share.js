import { clarificationContent, questionFor, textValue } from './clarification-content.js';
import { clarificationRecordReview } from '../../shared/clarification-record-state.js';

const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const WIDTH = 1600, SCALE = 1.5, INSET = 60, GAP = 20, CARD_PADDING = 34;
const COLORS = { ink: '#1e2c49', secondary: '#515c74', muted: '#747b8a', blue: '#173b8c', paper: '#fcf9f5', card: '#f0eae3' };

export function clarificationShareContent(item, meeting, { includeExplanation = false, includeResolution = false } = {}) {
  const content = clarificationContent(item);
  const retrospective = meeting.source === 'recording_import';
  const review = clarificationRecordReview(item);
  const notice = item.stale || item.clarification?.stale || review === 'source_changed'
    ? '原文已修改，内容待核对'
    : item.pendingReview || item.sourceRevision < meeting.transcriptRevision || review === 'newer_speech'
      ? retrospective ? '原文有更新，待复核' : '有新发言，待复核' : '';
  return {
    question: textValue(questionFor(item)),
    reason: content.reason,
    distinctions: content.distinctions.map(part => ({ title: textValue(part.title), text: textValue(part.text), example: textValue(part.example) })),
    explanation: includeExplanation ? content.explanation : '',
    explanationLabel: retrospective ? '回看这次讨论 · AI 解释' : '可以这样理解 · AI 建议',
    impact: content.separateImpact && (includeExplanation || !content.explanation) ? content.impact : '',
    resolution: includeResolution ? textValue(item.resolution?.text) : '',
    resolutionLabel: retrospective && item.resolution?.author === 'ai' ? '会上最后说到' : retrospective ? '补充的复盘记录' : '已记下的讨论结果',
    footer: [textValue(meeting.title), retrospective ? '复盘焦点' : '澄清问题', notice].filter(Boolean).join(' · '),
  };
}

export function clarificationShareFilename(item, meeting) {
  const clean = value => textValue(value).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
  return `${Array.from(clean(meeting.title) || '会议').slice(0, 24).join('')}-澄清问题-${Array.from(clean(questionFor(item)) || '分享').slice(0, 30).join('')}.png`;
}

// Keep words and emoji intact; split overlong tokens only when necessary.
// Moving trailing opening punctuation / leading closing punctuation avoids
// awkward Chinese line breaks without dropping any characters.
export function wrapShareText(text, maxWidth, measure) {
  const words = new Intl.Segmenter('zh', { granularity: 'word' });
  const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  const closing = /^[，。！？；：、）》】」』”’.,!?;:)]/;
  const opening = /[（《【「『“‘(]$/;
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    const tokens = [...words.segment(paragraph)].flatMap(({ segment }) => measure(segment) > maxWidth ? [...graphemes.segment(segment)].map(part => part.segment) : [segment]);
    for (const token of tokens) {
      if (line && measure(line + token) > maxWidth) {
        let carry = '';
        while (opening.test(line) || closing.test(token) && !carry) {
          const parts = [...graphemes.segment(line)].map(part => part.segment);
          if (parts.length <= 1) break;
          carry = parts.pop() + carry;
          line = parts.join('');
        }
        lines.push(line.trimEnd());
        line = carry + token.trimStart();
      } else line += token;
      // A carried opening mark can make even a full-width word overflow.
      if (measure(line) > maxWidth) {
        let rest = '';
        for (const { segment } of graphemes.segment(line)) {
          if (rest && measure(rest + segment) > maxWidth) { lines.push(rest); rest = ''; }
          rest += segment;
        }
        line = rest;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function renderClarificationShareImage(content) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片，请换一个浏览器重试。');
  const blocks = [], cards = [];
  const innerWidth = WIDTH - INSET * 2;
  function block(text, x, y, width, size, lineHeight, weight = 400, color = COLORS.ink) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrapShareText(text, width, value => ctx.measureText(value).width);
    blocks.push({ lines, x, y, size, lineHeight, weight, color });
    return y + lines.length * lineHeight;
  }
  let y = block(content.question, INSET, 56, innerWidth, 48, 68, 700);
  if (content.reason) y = block(content.reason, INSET, y + 30, innerWidth, 25, 45, 400, COLORS.secondary);
  const columns = Math.min(3, content.distinctions.length);
  const cardWidth = columns ? (innerWidth - GAP * (columns - 1)) / columns : 0;
  for (let index = 0; index < content.distinctions.length; index += columns) {
    const top = y + 38;
    const row = content.distinctions.slice(index, index + columns);
    const bottoms = row.map((part, column) => {
      const x = INSET + column * (cardWidth + GAP) + CARD_PADDING;
      const width = cardWidth - CARD_PADDING * 2;
      let bottom = block(part.title, x, top + CARD_PADDING, width, 28, 42, 700, COLORS.blue);
      bottom = block(part.text, x, bottom + 18, width, 24, 43);
      if (part.example) bottom = block(part.example, x, bottom + 22, width, 21, 37, 400, COLORS.muted);
      return bottom + CARD_PADDING;
    });
    y = Math.max(...bottoms);
    row.forEach((_, column) => cards.push({ x: INSET + column * (cardWidth + GAP), y: top, width: cardWidth, height: y - top }));
  }
  function note(label, text) {
    y = block(label, INSET, y + 34, innerWidth, 20, 32, 600, COLORS.blue);
    y = block(text, INSET, y + 8, innerWidth, 24, 42, 400, COLORS.secondary);
  }
  if (content.explanation) note(content.explanationLabel, content.explanation);
  if (content.impact) y = block(content.impact, INSET, y + 18, innerWidth, 23, 40, 400, COLORS.secondary);
  if (content.resolution) note(content.resolutionLabel, content.resolution);
  y = block(content.footer, INSET, y + 30, innerWidth, 18, 29, 400, COLORS.muted);
  const height = Math.ceil(y + 54);
  // Fail visibly rather than exporting a blank or clipped canvas.
  if (height * SCALE > 16000 || WIDTH * height * SCALE ** 2 > 32000000) throw new Error('这条问题内容过长，暂时无法生成完整图片。请先精简内容后重试。');
  canvas.width = WIDTH * SCALE;
  canvas.height = Math.ceil(height * SCALE);
  ctx.scale(SCALE, SCALE);
  const background = ctx.createLinearGradient(0, 0, WIDTH, height);
  background.addColorStop(0, '#1687a3'); background.addColorStop(0.48, '#849dc7'); background.addColorStop(1, '#e4acae');
  ctx.fillStyle = background; ctx.fillRect(0, 0, WIDTH, height);
  function rectangle(x, top, width, h, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x, top, width, h, radius); ctx.fill();
  }
  ctx.shadowColor = '#1e23404a'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 14;
  rectangle(28, 28, WIDTH - 56, height - 56, 42, COLORS.paper);
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  for (const card of cards) rectangle(card.x, card.y, card.width, card.height, 28, COLORS.card);
  ctx.textBaseline = 'middle';
  for (const item of blocks) {
    ctx.font = `${item.weight} ${item.size}px ${FONT}`;
    ctx.fillStyle = item.color;
    item.lines.forEach((line, index) => ctx.fillText(line, item.x, item.y + index * item.lineHeight + item.lineHeight / 2));
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败，请重试。')), 'image/png'));
  return { blob, width: canvas.width, height: canvas.height };
}
