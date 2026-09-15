const labels = { organize: '讨论分析', followup: '澄清检查', minutes: '讨论整理与纪要', refresh_speakers: '发言人核对' };

export function latestDiscussionJob(jobs = []) {
  const relevant = jobs.filter(job => labels[job.type]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return relevant.find(job => job.status === 'running') || relevant.find(job => job.status === 'queued') || relevant[0] || null;
}

export function needsManualAnalysis(meeting, { request = null, captureState = meeting?.capture?.state, configured = false, capturePending = false } = {}) {
  if (!meeting || meeting.archived || !configured || capturePending || !(meeting.transcriptRevision > 0)) return false;
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
