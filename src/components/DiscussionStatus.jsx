import { Check, CircleAlert, Clock3, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from './ui.jsx';

const labels = { organize: '讨论分析', followup: '澄清检查', minutes: '讨论整理与纪要' };

export function latestDiscussionJob(jobs = []) {
  const relevant = jobs.filter(job => labels[job.type]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return relevant.find(job => job.status === 'running') || relevant.find(job => job.status === 'queued') || relevant[0] || null;
}

export default function DiscussionStatus({ job, request, onRetry, onSettings, onHistory }) {
  const current = request || job;
  if (!current) return null;
  const label = labels[current.type] || '讨论分析';
  const busy = ['submitting', 'queued', 'running'].includes(current.status);
  const failed = current.status === 'error';
  const cancelled = current.status === 'cancelled';
  const total = Number(current.progress?.totalBatches || 0);
  const completed = Math.max(0, Math.min(total, Number(current.progress?.completedBatches || 0)));
  const noSource = current.result?.skipped === 'no_transcript';
  const unchanged = current.result?.skipped === 'no_new_transcript';
  const status = current.status === 'submitting' ? '正在提交分析请求' : current.status === 'queued' ? `${label}已排队` : current.status === 'running' ? `${label}进行中` : failed ? `${label}失败` : cancelled ? '本次分析未应用' : noSource ? '暂无可分析原文' : unchanged ? '没有新增原文需要整理' : `${label}已完成`;
  const Icon = failed || cancelled ? CircleAlert : current.status === 'queued' ? Clock3 : busy ? LoaderCircle : Check;
  return <div className={`discussion-job-status ${failed ? 'has-error' : cancelled ? 'is-cancelled' : busy ? 'is-pending' : 'is-done'}`} role={failed ? 'alert' : 'status'} aria-live="polite">
    <Icon size={15} className={busy && current.status !== 'queued' ? 'spin' : ''} />
    <div className="discussion-job-copy"><strong>{status}</strong>


      {current.status === 'running' && <p>{current.progress?.phase === 'clarify' ? '正在检查尚未说清的问题'  : total ? `已完成 ${completed} / ${total} 段整理` : '正在阅读会议原文' }</p>}
      {current.status === 'running' && total > 0 && <progress max={total} value={completed} aria-label="讨论分析进度" />}
      {failed && <p className="discussion-job-error">{current.error || '处理未完成，请重试或检查 AI 连接设置。'}</p>}
      {cancelled && <p>{current.error || '请依据最新原文重新分析。'}</p>}
      {noSource && <p>先完成转录或补充已核对的原文。</p>}
    </div>
    <div className="discussion-job-actions">{(failed || cancelled) && <><Button className="small" onClick={() => onRetry(current.type, current.input || {})}><RefreshCw size={12} />重试</Button><Button className="text-button small" onClick={onSettings}><Settings2 size={12} />AI 设置</Button></>}<Button className="text-button small" onClick={onHistory}>处理记录</Button></div>
  </div>;
}
