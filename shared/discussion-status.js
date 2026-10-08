import { awaitingSpeakers } from './meeting-scenarios.js';
const labels = { organize: '讨论分析', followup: '澄清检查', minutes: '讨论整理与纪要', refresh_speakers: 'AI 人物归属更新' };

export function speakerReviewProgress(job) {
  if (job?.type === 'refresh_speakers' && job.status === 'queued') return '说话人标记已保存。连续修改会合并处理，AI 内容将在后台更新，可以继续操作。';
  if (job?.type !== 'refresh_speakers' || job.status !== 'running') return '';
  const { totalRecords, completedRecords = 0, totalBatches, completedBatches = 0, activeBatches = 1, retrying, pendingRecords } = job.progress || {};
  if (!(totalRecords > 0)) return '说话人标记已保存，正在准备更新相关 AI 内容，可以继续操作。';
  const completed = Math.max(0, Math.min(totalRecords, completedRecords));
  const action = retrying ? `正在重新核对 ${pendingRecords} 项` : `已完成 ${completedBatches} / ${totalBatches} 批${activeBatches > 1 ? `，同时处理 ${activeBatches} 批` : ''}`;
  return `说话人标记已保存，可以继续操作。后台已核对 ${completed} / ${totalRecords} 项 AI 内容，${action}。全部通过后更新。`;
}

export function latestDiscussionJob(jobs = []) {
  const relevant = jobs.filter(job => labels[job.type]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return relevant.find(job => job.status === 'running') || relevant.find(job => job.status === 'queued') || relevant[0] || null;
}

export function needsManualAnalysis(meeting, { request = null, captureState = meeting?.capture?.state, configured = false, capturePending = false } = {}) {
  if (!meeting || awaitingSpeakers(meeting) || meeting.archived || !configured || capturePending || !(meeting.transcriptRevision > 0)) return false;
  const pendingSource = (meeting.processedRevision || 0) < meeting.transcriptRevision || (meeting.topics || []).some(topic => topic.stale);
  if (!pendingSource) return false;

  const jobs = meeting.jobs || [];
  const busy = status => ['submitting', 'queued', 'running'].includes(status);
  if (busy(request?.status) || jobs.some(job => ['import', 'organize', 'followup', 'minutes'].includes(job.type) && busy(job.status))) return false;

  // Failed work already has a retry action. Do not offer a second way to resume it.
  const failed = status => ['error', 'cancelled'].includes(status);
  if (failed((request || latestDiscussionJob(jobs))?.status)) return false;
  const latestImport = jobs.filter(job => job.type === 'import').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (failed(latestImport?.status)) return false;

  const automaticWillAnalyze = meeting.autoOrganize && meeting.status !== 'ended' && captureState === 'recording' && meeting.processedRevision !== meeting.transcriptRevision;
  return !automaticWillAnalyze;
}
