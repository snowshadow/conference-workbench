import { useEffect, useId, useState } from 'react';
import { Check, CircleAlert, Clock3, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { Button, Modal } from './ui.jsx';

const labels = { organize: '讨论分析', followup: '澄清检查', minutes: '讨论整理与纪要' };
const retrospectiveLabels = { organize: '会议复盘', followup: '复盘焦点整理', minutes: '会议复盘与纪要' };
const retrospectivePhases = { retrospective_extract: '梳理整场讨论', retrospective_topics: '梳理整场讨论', retrospective_focus: '整理复盘焦点' };

export default function DiscussionStatus({ job, request, retrospective = false, hasTopics = false, needsAnalysis = false, onAnalyze, onRetry, onSettings, onHistory }) {
  const pendingLabelId = useId();
  const current = request || job;
  const [previous, setPrevious] = useState(current);
  const [completedId, setCompletedId] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  if (previous?.id !== current?.id || previous?.status !== current?.status) {
    // Only acknowledge a completion observed in this visit, never an old job.
    // Adjust before commit so the focused button survives the completion frame.
    const completed = current?.status === 'done' && previous && ['submitting', 'queued', 'running'].includes(previous.status) && (previous.id === current.id || previous.status === 'submitting');
    setPrevious(current);
    setCompletedId(completed ? current.id : null);
  }
  useEffect(() => {
    if (!completedId || detailsOpen || focused) return;
    const timer = setTimeout(() => setCompletedId(null), 1800);
    return () => clearTimeout(timer);
  }, [completedId, detailsOpen, focused]);
  if (needsAnalysis && !detailsOpen) return <div className="discussion-status-slot manual-analysis-status">
    <span id={pendingLabelId} className="manual-analysis-label" role="status">{retrospective ? '会议尚未完成复盘' : '有内容尚未分析'}</span>
    <button type="button" className="manual-analysis-button" aria-describedby={pendingLabelId} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onClick={onAnalyze}>{retrospective ? '开始复盘' : '现在分析'}</button>
  </div>;
  if (!current) return null;
  const label = (retrospective ? retrospectiveLabels : labels)[current.type] || (retrospective ? '会议复盘' : '讨论分析');
  const phase = current.progress?.phase;
  const phaseLabel = retrospective && retrospectivePhases[phase];
  const busy = ['submitting', 'queued', 'running'].includes(current.status);
  const failed = current.status === 'error';
  const cancelled = current.status === 'cancelled';
  const total = Number(current.progress?.totalBatches || 0);
  const completed = Math.max(0, Math.min(total, Number(current.progress?.completedBatches || 0)));
  const noSource = current.result?.skipped === 'no_transcript';
  const unchanged = current.result?.skipped === 'no_new_transcript';
  const status = current.status === 'submitting' ? retrospective ? '正在提交复盘请求' : '正在提交分析请求' : current.status === 'queued' ? `${label}已排队` : current.status === 'running' ? phaseLabel || `${label}进行中` : failed ? `${label}失败` : cancelled ? retrospective ? '本次复盘未应用' : '本次分析未应用' : noSource ? '暂无可分析原文' : unchanged ? '没有新增原文需要整理' : `${label}已完成`;
  const shortStatus = current.status === 'submitting' ? '提交中' : current.status === 'queued' ? retrospective ? '等待复盘' : '等待分析' : failed ? retrospective ? '复盘未完成' : '分析失败' : cancelled ? retrospective ? '复盘未应用' : '分析未应用' : current.status === 'done' ? (noSource ? '暂无原文' : unchanged ? '无需更新' : '已更新') : phaseLabel || (retrospective ? '复盘中' : phase === 'clarify' || current.type === 'followup' ? '检查中' : current.type === 'minutes' ? '整理中' : '分析中');
  const visible = busy || failed || cancelled || current.status === 'done' && completedId === current.id;
  const showProgress = current.status === 'running' && total > 0 && !['clarify', 'retrospective_focus'].includes(phase);
  const count = showProgress ? `${completed}/${total}` : '';
  const Icon = failed || cancelled ? CircleAlert : current.status === 'queued' ? Clock3 : busy ? LoaderCircle : Check;
  const openAction = action => { setDetailsOpen(false); action(); };
  return <div className="discussion-status-slot">
    <span className="sr-only" role={failed ? 'alert' : 'status'} aria-live="polite">{visible ? status : ''}</span>
    {visible && <button type="button" className={`discussion-status-button ${failed ? 'has-error' : cancelled ? 'is-cancelled' : current.status === 'done' && !focused && !detailsOpen ? 'is-done' : ''}`} aria-label={`${status}${count ? `，已完成 ${completed} / ${total} 段整理` : ''}，查看详情`} aria-haspopup="dialog" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onClick={() => setDetailsOpen(true)} title="查看处理详情">
      <Icon size={14} aria-hidden="true" className={busy && current.status !== 'queued' ? 'spin' : ''} />
      <span className="discussion-status-label">{shortStatus}</span>{count && <span className="discussion-status-count" aria-hidden="true">{count}</span>}
    </button>}
    {detailsOpen && <Modal title="处理详情" onClose={() => setDetailsOpen(false)}>
      <div className="discussion-status-details">
        <strong className={failed ? 'discussion-status-error' : ''}>{status}</strong>
        {current.status === 'running' && <p>{retrospective && phase === 'retrospective_focus' ? '回看不同理解、隐含前提，以及会上最后说清了什么。' : retrospective && phase === 'retrospective_topics' ? '将整场发言组织成主题，保留讨论如何展开。' : phase === 'clarify' ? '正在检查尚未说清的问题' : total ? `已完成 ${completed} / ${total} 段整理` : '正在阅读会议原文'}</p>}
        {showProgress && <progress max={total} value={completed} aria-label={retrospective ? '会议复盘进度' : '讨论分析进度'} />}
        {failed && <p className="discussion-status-error">{current.error || '处理未完成，请重试或检查 AI 连接设置。'}</p>}
        {failed && retrospective && hasTopics && <p>已完成的主题整理会保留，可重试继续复盘。</p>}
        {cancelled && <p>{current.error || (retrospective ? '请依据最新原文重新复盘。' : '请依据最新原文重新分析。')}</p>}
        {noSource && <p>先完成转录或补充已核对的原文。</p>}
        <div className="discussion-status-actions">{(failed || cancelled) && <><Button className="primary" onClick={() => openAction(() => onRetry(current.type, current.input || {}))}><RefreshCw size={13} />重试</Button><Button className="text-button" onClick={() => openAction(onSettings)}><Settings2 size={13} />AI 设置</Button></>}<Button className="text-button" onClick={() => openAction(onHistory)}>处理记录</Button></div>
      </div>
    </Modal>}
  </div>;
}
