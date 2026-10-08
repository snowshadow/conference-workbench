export const textValue = value => typeof value === 'string' ? value.trim() : '';
export const sameText = (first, second) => textValue(first).replace(/\s+/g, '') === textValue(second).replace(/\s+/g, '');
export const questionFor = item => !item.stale && !item.resolution?.stale && item.shortQuestion ? item.shortQuestion : item.question;

// Reading and image export use the same text and stale-content rules.
export function clarificationContent(item) {
  const clarification = item.clarification?.stale ? null : item.clarification;
  const explanation = textValue(clarification?.explanation);
  const distinctions = (clarification?.distinctions || []).filter(value => !value.stale && textValue(value.title) && textValue(value.text));
  const manualReason = item.manualFields?.includes('discussionValue') || ['host', 'agent'].includes(item.author);
  const reason = (manualReason ? textValue(item.discussionValue) : '') || textValue(item.rationale) || textValue(item.discussionValue) || (!explanation ? textValue(item.impact) : '');
  const impact = textValue(item.impact);
  return { explanation, distinctions, reason, impact, separateImpact: Boolean(impact && !sameText(impact, reason) && !sameText(impact, explanation)) };
}
