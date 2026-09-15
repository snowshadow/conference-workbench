export function questionRequestKey(input = {}) {
  return JSON.stringify([input.topicId || '', String(input.question || '').trim()]);
}

/** Keep unfinished questions visible; older failures remain in processing history. */
export function questionFeedback(jobs = [], questions = []) {
  const answers = jobs.filter(job => job.type === 'answer').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const pending = answers.filter(job => ['queued', 'running'].includes(job.status));
  const latest = answers[0];
  const answered = latest && questions.some(item => questionRequestKey(item) === questionRequestKey(latest.input)
    && String(item.createdAt || '') >= String(latest.createdAt || ''));
  const failed = latest && !answered && ['error', 'cancelled'].includes(latest.status) ? latest : null;
  return [...pending, ...(failed ? [failed] : [])].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function questionProgressLabel(job) {
  if (job.status === 'queued') return '等待处理';
  if (job.progress?.phase === 'answer') return '正在组织回答';
  const { phase, completedBatches, totalBatches } = job.progress || {};
  if (phase === 'select' && Number.isInteger(totalBatches) && totalBatches > 0 && Number.isInteger(completedBatches)) {
    return `正在阅读会议原文 · ${Math.max(0, Math.min(completedBatches, totalBatches))}/${totalBatches} 段`;
  }
  return '正在阅读会议原文';
}
