const preservedContent = '本次未更新 AI 内容，已保存的姓名标记和原文不受影响。';

export const peopleReviewErrors = Object.fromEntries(Object.entries({
  validation: 'AI 返回的发言人核对结果未通过校验。',
  incomplete: 'AI 未返回完整的发言人核对内容。',
  evidence: 'AI 返回的原文引用未通过校验。',
  attribution: 'AI 标注的人物归属与引用的发言人不一致。',
  links: 'AI 改动了纪要中的原文链接，核对结果未通过校验。',
}).map(([reason, message]) => [reason, message + preservedContent]));

// Older jobs combined several validation failures in one message. Keep their
// cause generic and their stored error intact; do not infer a missing source.
const legacyErrors = new Map([
  ['发言人核对的原文依据不完整，原内容已保留，请重试。', peopleReviewErrors.validation],
  ['AI 未能完整核对发言人，原内容已保留，请重试。', peopleReviewErrors.incomplete],
  ['纪要的原文引用发生变化，原内容已保留，请重试。', peopleReviewErrors.links],
]);

export function presentPeopleReviewError(job) {
  return job.type === 'refresh_speakers' ? legacyErrors.get(job.error) || job.error : job.error;
}
