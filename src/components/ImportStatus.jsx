import { CircleAlert, FileAudio, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from './ui.jsx';
import { formatTime } from '../lib/api.js';

export default function ImportStatus({ job, retrying, onRetry, onSettings, llmConfigured }) {
  if (!job) return null;
  const progress = job.progress || {};
  const busy = ['queued', 'running'].includes(job.status);
  const failed = job.status === 'error';
  const noTranscript = job.status === 'done' && job.result?.analysisState === 'no_transcript';
  const phase = failed ? '录音转录未完成' : job.status === 'done' ? '录音已导入' : job.status === 'queued' ? '等待处理录音' : progress.phase === 'decoding' ? '正在准备录音' : progress.phase === 'transcribing' ? '正在转录录音' : '正在处理录音';
  const transcribing = progress.phase === 'transcribing';
  const duration = formatTime((progress.totalSeconds || 0) * 1000);
  const completed = formatTime(Math.min(progress.totalSeconds || 0, progress.processedSeconds || 0) * 1000);
  const needsAi = job.status === 'done' && !noTranscript && !llmConfigured;
  return <div className={`import-status ${busy ? 'is-busy' : ''} ${failed ? 'has-error' : ''}`} role="status">
    <div className="import-status-icon">{busy ? <LoaderCircle size={16} className="spin" /> : failed ? <CircleAlert size={16} /> : <FileAudio size={16} />}</div>
    <div className="import-status-copy"><div><strong>{phase}</strong>{transcribing && progress.totalSeconds > 0 && <span>{progress.totalChunks === 1 ? `录音 ${duration}` : `已完成 ${completed} / ${duration}`}</span>}{job.status === 'done' && <span>音频保存在本机 · 可定位回听</span>}</div>
      {busy && <p>{transcribing ? '完成后显示原文，处理会在后台继续。' : '正在保存并准备可回听的音频。'}</p>}
      {failed && <p>{job.error || '处理暂时中断。'} 原录音和已完成的转录已保留，重试会继续未完成的部分。</p>}
      {noTranscript && <p>{job.result.message || '未识别出文字，请回听核对录音。'} 确认原文后再进行 AI 复盘。</p>}
      {needsAi && <p>转录与回听已就绪，配置 AI 后可复盘整场讨论。</p>}
      {job.status === 'done' && !needsAi && job.result?.analysisState === 'failed' && <p>{job.result.message || '自动复盘未启动，可从「会议操作」重新复盘。'}</p>}
    </div>
    {failed && <><Button className="text-button small" onClick={onSettings}><Settings2 size={12} />转录设置</Button><Button className="small" onClick={onRetry} busy={retrying}><RefreshCw size={12} />重试导入</Button></>}
    {needsAi && <Button className="small" onClick={onSettings}><Settings2 size={12} />配置 AI</Button>}
    {noTranscript && job.result?.recordingId && <a className="button small" href={`/api/recordings/${encodeURIComponent(job.result.recordingId)}/audio`} target="_blank" rel="noreferrer"><FileAudio size={12} />回听录音</a>}
  </div>;
}
