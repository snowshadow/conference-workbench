import { memo, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronDown, ChevronRight, CircleHelp, Compass, LoaderCircle, Pencil, Quote, Scale } from 'lucide-react';
import { Button, EmptyState, Evidence, FormError, IconButton, Modal, useFormAction } from './ui.jsx';
import { api, formatTime, meetingPath } from '../lib/api.js';
import { isActiveFocus, readingFocusId, recommendedFocusId, returnFocusId } from '../../shared/discussion-view.js';
import { resolutionOutcomes } from '../../shared/resolution-copy.js';
import { clarificationRecordReview } from '../../shared/clarification-record-state.js';

export const clarificationKinds = {
  concept: { label: '概念澄清', icon: Quote },
  assumption: { label: '隐含假设', icon: Compass },
  criteria: { label: '取舍标准', icon: Scale },
  other: { label: '值得澄清', icon: CircleHelp },
};

const questionFor = item => !item.stale && !item.resolution?.stale && item.shortQuestion ? item.shortQuestion : item.question;

export function ResolutionSummary({ item, onEvidence, onEdit, onRead, compact = false }) {
  const resolution = item.resolution;
  if (!resolution) return null;
  const outcome = resolutionOutcomes[resolution.outcome];
  const origin = resolution.author === 'ai' ? 'AI 依据原文整理' : resolution.author === 'agent' ? 'Agent 记录' : '主持人记录';
  const neutral = resolution.outcome === 'recorded';
  const partial = item.status === 'active' || resolution.complete === false;
  const review = clarificationRecordReview(item);
  return <div className={`resolution-summary quiet-resolution ${compact ? 'compact' : ''} outcome-${resolution.outcome}`}>
    <p className="resolution-text">{resolution.text}</p>
    {review && <p className={`record-review-state ${review}`} role="status">{review === 'source_changed' ? '引用的原文已修改，请核对这条记录。' : 'AI 尚未核对后续发言。'}</p>}
    <div className="resolution-heading"><span className="resolution-origin">{origin}</span>{partial ? <span className="resolution-partial-label">已说清的部分</span> : !neutral && <span className={`outcome-badge ${resolution.outcome}`}>{outcome?.label || '讨论记录'}</span>}{onEdit && <IconButton title="编辑讨论记录" onClick={() => onEdit(item.id)}><Pencil size={13} /></IconButton>}</div>
    <details className="resolution-provenance" onToggle={event => { if (event.currentTarget.open) onRead?.(); }}>
      <summary>{resolution.evidenceIds?.length ? `查看来源 · ${resolution.evidenceIds.length} 处` : '记录信息'}<ChevronDown size={12} aria-hidden="true" /></summary>
      <div className="resolution-evidence"><Evidence ids={resolution.evidenceIds} onSelect={onEvidence} /></div>
      {(!resolution.evidenceIds?.length || neutral) && <dl className="reading-metadata">{!resolution.evidenceIds?.length && <div><dt>原文引用</dt><dd>未关联</dd></div>}{neutral && <div><dt>问题状态</dt><dd>已记下结果，尚未标记已解决</dd></div>}</dl>}
    </details>
  </div>;
}

function ResolutionEditor({ item, meeting, lines = [], mutate, onClose, inline = false }) {
  const [outcome, setOutcome] = useState(item.status === 'active' ? 'recorded' : item.resolution?.outcome || 'recorded');
  const [text, setText] = useState(item.resolution?.text || '');
  const [evidenceIds, setEvidenceIds] = useState(item.resolution?.evidenceIds || []);
  const [sourceRevision, setSourceRevision] = useState(meeting.transcriptRevision);
  const [transcriptEditRevision, setTranscriptEditRevision] = useState(meeting.transcriptEditRevision || 0);
  const [baselineTime, setBaselineTime] = useState(meeting.updatedAt || '');
  const [review, setReview] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const textarea = useRef(null);
  const noteId = useId();
  const outdated = transcriptEditRevision < (meeting.transcriptEditRevision || 0);
  const reviewOutdated = review && review.transcriptEditRevision < (meeting.transcriptEditRevision || 0);
  useEffect(() => {
    const field = textarea.current;
    field?.focus({ preventScroll: true });
    if (!inline || !field) return;
    const viewport = field.closest('.clarification-scroll');
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const editor = field.closest('form').getBoundingClientRect();
    const offset = Math.min(editor.bottom - bounds.bottom + 18, editor.top - bounds.top - 18);
    if (offset > 0) viewport.scrollBy({ top: offset, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [inline]);
  const choices = [...new Set([...(item.evidenceIds || []), ...(item.resolution?.evidenceIds || [])])];
  const evidenceText = id => review?.lines.find(line => line.id === id)?.text || lines.find(line => line.id === id)?.text || [...(item.resolution?.evidence || []), ...(item.evidence || [])].find(source => (source.id || source.lineId) === id)?.quote || '';
  async function reviewSources() {
    setReviewBusy(true); setReviewError(''); setReview(null);
    try {
      const before = await api(meetingPath(meeting.id));
      const relatedIds = new Set([...choices, ...evidenceIds]);
      const currentLines = [];
      let cursor = 0;
      while (cursor !== null) {
        const page = await api(`${meetingPath(meeting.id, '/transcript')}?cursor=${cursor}&limit=500`);
        currentLines.push(...page.lines.filter(line => relatedIds.has(line.id) || line.editedAt && (!baselineTime || line.editedAt >= baselineTime)));
        cursor = page.nextCursor;
      }
      const after = await api(meetingPath(meeting.id));
      if ((before.transcriptEditRevision || 0) !== (after.transcriptEditRevision || 0)) throw new Error('读取时原文又有修正，请重新核对。');
      setReview({ lines: currentLines, transcriptRevision: before.transcriptRevision, transcriptEditRevision: after.transcriptEditRevision || 0, updatedAt: after.updatedAt });
    } catch (failure) { setReviewError(failure.message); } finally { setReviewBusy(false); }
  }
  async function acceptReview() {
    if (!review || reviewOutdated) return;
    setReviewBusy(true); setReviewError('');
    try {
      const latest = await api(meetingPath(meeting.id));
      if ((latest.transcriptEditRevision || 0) !== review.transcriptEditRevision) throw new Error('核对期间原文又有修正，请重新核对。');
      setSourceRevision(review.transcriptRevision);
      setTranscriptEditRevision(review.transcriptEditRevision);
      setBaselineTime(review.updatedAt);
    } catch (failure) { setReviewError(failure.message); setReview(null); } finally { setReviewBusy(false); }
  }
  const { submit, error, busy } = useFormAction(async () => {
    await mutate(`/followups/${item.id}`, 'PATCH', { status: outcome === 'recorded' ? 'recorded' : 'resolved', author: 'host', sourceRevision, transcriptEditRevision, resolution: { outcome, text: text.trim(), evidenceIds } });
    onClose();
  });
  const cancelAction = <Button className={inline ? 'text-button' : ''} type="button" onClick={onClose} disabled={busy || reviewBusy}>取消</Button>;
  const form = <form className={`resolution-editor ${inline ? 'is-inline' : ''}`} onSubmit={submit}>
    {!inline && <p className="resolution-context">{questionFor(item)}</p>}
    <label htmlFor={noteId}>这次说清了什么，还有什么没定？</label>
    <textarea id={noteId} ref={textarea} rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="用自己的话记下来…" required maxLength={4000} disabled={busy} />
    <details className="resolution-extra"><summary>补充说明（可选）{item.resolution?.outcome && item.resolution.outcome !== 'recorded' ? ` · ${resolutionOutcomes[item.resolution.outcome]?.label || ''}` : ''}</summary>
      <label>这个问题现在怎么样了？<select value={outcome} onChange={event => setOutcome(event.target.value)} disabled={busy}>{Object.entries(resolutionOutcomes).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}</select><span className="form-hint">{resolutionOutcomes[outcome]?.description}</span></label>
      {choices.length > 0 && <fieldset className="resolution-sources"><legend>附上原话 <span className="optional">可选</span></legend><p>勾选作为依据的原话，方便以后回看。</p>{choices.map((id, index) => <label className="checkbox-label" key={id}><input type="checkbox" checked={evidenceIds.includes(id)} disabled={busy} onChange={event => setEvidenceIds(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))} /><span><strong>原文 {index + 1}</strong>{evidenceText(id) || '这段原话已关联到当前问题'}</span></label>)}</fieldset>}
      <p className="resolution-source">保存为主持人记录{!evidenceIds.length && ' · 未关联原文'}</p>
    </details>
    {outdated && <section className="resolution-review"><p className="form-error" role="alert">原文已修正，输入已保留。核对后可继续保存。</p><Button className="text-button" busy={reviewBusy} onClick={reviewSources}>核对最新原文</Button>{review && <><div className="resolution-review-lines">{review.lines.length ? review.lines.map(line => <blockquote key={line.id}><time>{formatTime(line.startMs)}</time><p>{line.text}</p></blockquote>) : <p>当前没有关联原文，也没有找到需核对的修正发言。请确认这份记录仍适用于当前讨论。</p>}</div>{reviewOutdated && <p className="form-error">原文又有修正，请重新核对。</p>}<Button onClick={acceptReview} disabled={reviewOutdated} busy={reviewBusy}>已核对，继续编辑</Button></>}<FormError error={reviewError} /></section>}
    <FormError error={error} /><div className="resolution-editor-actions">{!inline && cancelAction}<Button className="primary" type="submit" busy={busy} disabled={!text.trim() || outdated || reviewBusy}>保存记录</Button>{inline && cancelAction}</div>
  </form>;
  return inline ? form : <Modal title={item.resolution ? '编辑讨论记录' : '记下讨论结果'} onClose={onClose} closeDisabled={busy || reviewBusy}>{form}</Modal>;
}

export function ResolutionDialog(props) { return <ResolutionEditor {...props} />; }

function QuestionEvidence({ item, meeting, onEvidence, onTopic, onRead }) {
  const count = new Set(item.evidenceIds || []).size;
  const byId = new Map((item.evidence || []).map(source => [source.id || source.lineId, source.quote]));
  return <details className="focus-evidence" onToggle={event => { if (event.currentTarget.open) onRead(); }}>
    <summary>查看依据{count > 0 ? ` · ${count} 处` : ''}<ChevronDown size={13} aria-hidden="true" /></summary>
    <div className="focus-evidence-body">
      {item.rationale && <p className="focus-evidence-explanation">{item.rationale}</p>}
      {item.evidenceIds?.some(id => byId.get(id)) && <div className="focus-quotes">{[...new Set(item.evidenceIds)].filter(id => byId.get(id)).map(id => <blockquote key={id}><p>{byId.get(id)}</p><Evidence ids={[id]} onSelect={onEvidence} /></blockquote>)}</div>}
      <Evidence ids={(item.evidenceIds || []).filter(id => !byId.get(id))} onSelect={onEvidence} />
      <details className="focus-source-details"><summary>问题详情</summary><p>{item.question}</p>{item.impact && <p>{item.impact}</p>}<div className="focus-source-meta"><span>{clarificationKinds[item.kind]?.label || '既有追问'}</span>{item.topicId && <button type="button" onClick={() => onTopic(item.topicId)}>{meeting.topics?.find(topic => topic.id === item.topicId)?.title || '相关主题'}<ChevronRight size={12} aria-hidden="true" /></button>}</div></details>
    </div>
  </details>;
}

function ClarificationPanel({ meeting, selected, setSelected, onEvidence, onTopic, mutate, job, analysisStatus, onRequestQuestion, questionRequestBusy = false, pauseFollowing = false, toolbarTarget, visible = true }) {
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const recordTrigger = useRef(null);
  const focusHeading = useRef(null);
  const readingScroll = useRef(null);
  const [following, setFollowing] = useState(true);
  const active = (meeting.followups || []).filter(isActiveFocus);
  const readingId = readingFocusId(meeting, selected, following, Boolean(editingItem) || pauseFollowing);
  const returnTarget = returnFocusId(meeting, readingId);
  const selectedItem = (meeting.followups || []).find(item => item.id === readingId);
  const current = isActiveFocus(selectedItem) ? selectedItem : null;
  const otherItems = active.filter(item => item.id !== current?.id);
  useEffect(() => {
    if (selected !== readingId) setSelected(readingId);
  }, [readingId, selected, setSelected]);
  function holdReading() { setSelected(readingId); setFollowing(false); }
  function showEvidence(id) { holdReading(); onEvidence(id); }
  function editResult(item) { setSelected(readingId); setEditingItem(item); }
  function returnToRecommended() {
    if (!returnTarget) return;
    setFollowing(true);
    setSelected(returnTarget);
    requestAnimationFrame(() => {
      readingScroll.current?.scrollTo({ top: 0, behavior: 'instant' });
      focusHeading.current?.focus({ preventScroll: true });
    });
  }
  async function ignore(id) {
    setUpdating(id); setError('');
    try {
      const updated = await mutate(`/followups/${id}`, 'PATCH', { status: 'ignored' });
      setSelected(recommendedFocusId(updated));
      setFollowing(true);
    } catch (failure) { setError(failure.message); } finally { setUpdating(''); }
  }
  const selectedResult = ['resolved', 'recorded'].includes(selectedItem?.status) && selectedItem.resolution;
  const staleResult = selectedResult && clarificationRecordReview(selectedItem) === 'source_changed';
  const importing = meeting.jobs?.some(item => item.type === 'import' && ['queued', 'running'].includes(item.status));
  const analyzing = ['submitting', 'queued', 'running'].includes(analysisStatus?.status) || job || meeting.jobs?.some(item => ['organize', 'followup', 'minutes'].includes(item.type) && ['queued', 'running'].includes(item.status));
  const emptyState = importing || !meeting.transcriptRevision ? {
    title: '等待录音转录', text: importing ? '录音正在处理，获得原文后开始分析。' : '开始录音或导入录音后，从实际发言中寻找值得讨论的问题。',
  } : analysisStatus?.status === 'error' ? {
    title: '本次分析未完成', text: '可以根据上方提示重试，原文和人工修正会保留。',
  } : analyzing ? {
    title: analysisStatus?.status === 'submitting' ? '正在提交分析' : analysisStatus?.status === 'queued' ? '等待开始分析' : '正在分析讨论', text: '从原文中检查不同理解、隐含前提和取舍。',
  } : !meeting.processedRevision ? {
    title: '等待分析这次讨论', text: '原文已保存，可从会议菜单重新分析。',
  } : meeting.processedRevision < meeting.transcriptRevision ? {
    title: '有新原文，等待更新分析', text: '整理完成后再查看新的问题。',
  } : {
    title: '可以继续讨论', text: '暂时没有需要停下来澄清的问题。',
  };
  const requestQuestion = onRequestQuestion && <Button className="text-button focus-request" onClick={onRequestQuestion} disabled={questionRequestBusy || !meeting.transcriptRevision} busy={questionRequestBusy}>请 AI 再提问</Button>;
  const closeEditor = () => { setEditingItem(null); requestAnimationFrame(() => (recordTrigger.current || focusHeading.current)?.focus({ preventScroll: true })); };
  const readingState = current ? 'active' : selectedResult ? (staleResult ? 'saved-stale' : 'saved') : selectedItem ? 'previous' : 'empty';
  return <div className="clarification-content reading-focus">
    {visible && toolbarTarget && returnTarget && createPortal(<Button className="focus-return-button" onClick={returnToRecommended} disabled={Boolean(editingItem) || pauseFollowing || Boolean(updating)} aria-label="回到推荐问题" title="回到推荐问题"><ArrowLeft size={15} aria-hidden="true" /><span>回到推荐问题</span></Button>, toolbarTarget)}
    <FormError error={error} />
    <div className="clarification-scroll" ref={readingScroll}>
      <div className="focus-reading-view" key={`${readingId || 'none'}:${readingState}`}>
      {current ? <article className="focus-question">
        <p className="focus-origin">{current.author === 'agent' ? 'Agent 提问' : current.author === 'host' ? '主持人提问' : 'AI 提问'}{(current.pendingReview || current.sourceRevision < meeting.transcriptRevision) && <span role="status">有新发言，待复核</span>}</p>
        <h3 ref={focusHeading} tabIndex={-1}>{questionFor(current)}</h3>
        {(current.discussionValue || current.impact || current.rationale) && <p className="focus-value">{current.discussionValue || current.impact || current.rationale}</p>}
        {current.resolution && <div className="focus-partial"><ResolutionSummary item={current} onEvidence={showEvidence} onRead={holdReading} /></div>}
        <QuestionEvidence key={current.id} item={current} meeting={meeting} onEvidence={showEvidence} onTopic={onTopic} onRead={holdReading} />
        {!editingItem && <div className="focus-actions"><Button ref={recordTrigger} className="primary" onClick={() => editResult(current)}>记下讨论结果</Button><Button className="text-button" disabled={updating === current.id} onClick={() => ignore(current.id)}>先放下</Button></div>}
      </article> : selectedResult ? <article className={`focus-saved${staleResult ? ' is-stale' : ''}`}><p className="focus-origin" role="status">{staleResult ? '此前的问题' : '已保存到讨论进展'}</p><h3 ref={focusHeading} tabIndex={-1}>{questionFor(selectedItem)}</h3><ResolutionSummary item={selectedItem} onEvidence={showEvidence} onEdit={editingItem ? undefined : () => editResult(selectedItem)} /></article> : selectedItem && (selectedItem.stale || selectedItem.status !== 'active') ? <div className="clarification-transition"><h3>{selectedItem.stale ? '刚才的问题需要重新核对' : selectedItem.status === 'ignored' ? '这条问题已先放下' : '刚才的问题已处理'}</h3><p>{selectedItem.stale ? '原文已修正，更新后再查看。' : '可以回到当前讨论。'}</p></div> : <EmptyState title={emptyState.title} action={!active.length && !importing && !analyzing && meeting.processedRevision ? requestQuestion : null}>{emptyState.text}</EmptyState>}
      </div>
      {editingItem && <ResolutionEditor key={editingItem.id} inline item={(meeting.followups || []).find(item => item.id === editingItem.id) || editingItem} meeting={meeting} mutate={mutate} onClose={closeEditor} />}
      {otherItems.length > 0 && <details className="focus-queue"><summary>其他问题 · {otherItems.length}<ChevronDown size={13} aria-hidden="true" /></summary><div>{otherItems.map(item => <button className="focus-queue-item" key={item.id} disabled={Boolean(editingItem)} onClick={() => { setFollowing(false); setSelected(item.id); }}><span>{questionFor(item)}</span><ChevronRight size={15} aria-hidden="true" /></button>)}{requestQuestion}</div></details>}
    </div>
    {job && <div className="working-line"><LoaderCircle size={13} className="spin" />正在寻找新的问题…</div>}
  </div>;
}

function ProgressPanel({ meeting, onEvidence, onResolve }) {
  const records = (meeting.followups || []).filter(item => !item.mergedInto && ['active', 'resolved', 'recorded'].includes(item.status) && item.resolution);
  const unrecorded = (meeting.followups || []).filter(item => !item.mergedInto && item.status === 'resolved' && !item.resolution);
  const ignored = (meeting.followups || []).filter(item => !item.mergedInto && item.status === 'ignored');
  const merged = (meeting.followups || []).filter(item => item.mergedInto);
  return <div className="progress-content"><div className="progress-scroll">
    {!records.length ? <EmptyState compact title="还没有讨论记录">在问题下方记下讨论结果，会保存在这里。</EmptyState> : records.map(item => <article className="progress-card" key={item.id}><h3 className="progress-question">{questionFor(item)}</h3><ResolutionSummary item={item} compact onEvidence={onEvidence} onEdit={onResolve} /></article>)}
    {(unrecorded.length > 0 || ignored.length > 0 || merged.length > 0) && <details className="processed-clarifications"><summary>其他已处理问题 · {unrecorded.length + ignored.length + merged.length}</summary>{unrecorded.map(item => <div key={item.id}><span>已处理，未记录结果</span><p>{item.question}</p><Button className="text-button small" onClick={() => onResolve(item.id)}><Pencil size={11} />补记结果</Button></div>)}{ignored.map(item => <div key={item.id}><span>已先放下</span><p>{item.question}</p></div>)}{merged.map(item => <div key={item.id}><span>已并入其他问题</span><p>{item.question}</p>{item.resolution && <ResolutionSummary item={item} compact onEvidence={onEvidence} />}</div>)}</details>}
  </div></div>;
}

const MemoClarificationPanel = memo(ClarificationPanel);
const MemoProgressPanel = memo(ProgressPanel);
export { MemoClarificationPanel as ClarificationPanel, MemoProgressPanel as ProgressPanel };
