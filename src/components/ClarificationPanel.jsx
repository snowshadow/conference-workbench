import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Compass, LoaderCircle, Pencil, Quote, Scale } from 'lucide-react';
import { Button, EmptyState, Evidence, FormError, IconButton, Modal, useFormAction } from './ui.jsx';
import { api, formatTime, meetingPath } from '../lib/api.js';
import { isReadingFocus, orderedFocuses, browseFocusIds, focusPriority, readingFocusId, recommendedFocusId, returnFocusId } from '../../shared/discussion-view.js';
import { resolutionOutcomes } from '../../shared/resolution-copy.js';
import { clarificationRecordReview } from '../../shared/clarification-record-state.js';

export const clarificationKinds = {
  concept: { label: '概念澄清', icon: Quote },
  assumption: { label: '隐含假设', icon: Compass },
  criteria: { label: '取舍标准', icon: Scale },
  other: { label: '值得澄清', icon: CircleHelp },
};

const questionFor = item => !item.stale && !item.resolution?.stale && item.shortQuestion ? item.shortQuestion : item.question;
const textValue = value => typeof value === 'string' ? value.trim() : '';
const sameText = (first, second) => textValue(first).replace(/\s+/g, '') === textValue(second).replace(/\s+/g, '');

// One source can support several distinctions. Keep its different excerpts together.
function questionSources(item) {
  const sources = new Map();
  const clarification = item.clarification?.stale ? null : item.clarification;
  function add(id, quote) {
    if (!id) return;
    if (!sources.has(id)) sources.set(id, { id, quotes: [] });
    const text = textValue(quote);
    if (text && !sources.get(id).quotes.includes(text)) sources.get(id).quotes.push(text);
  }
  for (const group of [item, clarification, ...(clarification?.distinctions || []).filter(part => !part.stale), item.resolution, item.priority?.stale ? null : item.priority]) {
    for (const id of group?.evidenceIds || []) add(id);
    for (const source of group?.evidence || []) add(source.id || source.lineId, source.quote);
  }
  return [...sources.values()];
}

export function ResolutionSummary({ item, onEvidence, onEdit, onRead, compact = false, showProvenance = true, retrospective = false }) {
  const resolution = item.resolution;
  if (!resolution) return null;
  const outcome = resolutionOutcomes[resolution.outcome];
  const origin = resolution.author === 'ai' ? 'AI 依据原文整理' : resolution.author === 'agent' ? 'Agent 记录' : '主持人记录';
  const neutral = resolution.outcome === 'recorded';
  const partial = item.status === 'active' || resolution.complete === false;
  const review = clarificationRecordReview(item);
  return <div className={`resolution-summary quiet-resolution ${compact ? 'compact' : ''} outcome-${resolution.outcome}`}>
    <p className="resolution-text">{resolution.text}</p>
    {review && <p className={`record-review-state ${review}`} role="status">{review === 'source_changed' ? '引用的原文已修改，请核对这条记录。' : retrospective ? '原文有更新，这条记录待核对。' : 'AI 尚未核对后续发言。'}</p>}
    <div className="resolution-heading"><span className="resolution-origin">{origin}</span>{partial ? <span className="resolution-partial-label">{retrospective ? '仍有未定的部分' : '已说清的部分'}</span> : !neutral && <span className={`outcome-badge ${resolution.outcome}`}>{outcome?.label || '讨论记录'}</span>}{onEdit && <IconButton title={retrospective ? '编辑复盘记录' : '编辑讨论记录'} onClick={() => onEdit(item.id)}><Pencil size={13} /></IconButton>}</div>
    {showProvenance && <details className="resolution-provenance" onToggle={event => { if (event.currentTarget.open) onRead?.(); }}>
      <summary>{resolution.evidenceIds?.length ? `查看来源 · ${resolution.evidenceIds.length} 处` : '记录信息'}<ChevronDown size={12} aria-hidden="true" /></summary>
      <div className="resolution-evidence"><Evidence ids={resolution.evidenceIds} onSelect={onEvidence} /></div>
      {(!resolution.evidenceIds?.length || neutral) && <dl className="reading-metadata">{!resolution.evidenceIds?.length && <div><dt>原文引用</dt><dd>未关联</dd></div>}{neutral && <div><dt>{retrospective ? '记录状态' : '问题状态'}</dt><dd>{retrospective ? '复盘记录已保存' : '已记下结果，尚未标记已解决'}</dd></div>}</dl>}
    </details>}
  </div>;
}

function ResolutionEditor({ item, meeting, lines = [], mutate, onClose, inline = false }) {
  const retrospective = meeting.source === 'recording_import';
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
  const sources = questionSources(item);
  const choices = sources.map(source => source.id);
  const evidenceText = id => review?.lines.find(line => line.id === id)?.text || lines.find(line => line.id === id)?.text || sources.find(source => source.id === id)?.quotes.join('\n\n') || '';
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
    <label htmlFor={noteId}>{retrospective ? '回看这次讨论，你想补充或修正什么？' : '这次说清了什么，还有什么没定？'}</label>
    <textarea id={noteId} ref={textarea} rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="用自己的话记下来…" required maxLength={4000} disabled={busy} />
    <details className="resolution-extra"><summary>补充说明（可选）{item.resolution?.outcome && item.resolution.outcome !== 'recorded' ? ` · ${resolutionOutcomes[item.resolution.outcome]?.label || ''}` : ''}</summary>
      <label>这个问题现在怎么样了？<select value={outcome} onChange={event => setOutcome(event.target.value)} disabled={busy}>{Object.entries(resolutionOutcomes).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}</select><span className="form-hint">{resolutionOutcomes[outcome]?.description}</span></label>
      {choices.length > 0 && <fieldset className="resolution-sources"><legend>附上原话 <span className="optional">可选</span></legend><p>勾选作为依据的原话，方便以后回看。</p>{choices.map((id, index) => <label className="checkbox-label" key={id}><input type="checkbox" checked={evidenceIds.includes(id)} disabled={busy} onChange={event => setEvidenceIds(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))} /><span><strong>原文 {index + 1}</strong>{evidenceText(id) || '这段原话已关联到当前问题'}</span></label>)}</fieldset>}
      <p className="resolution-source">保存为主持人记录{!evidenceIds.length && ' · 未关联原文'}</p>
    </details>
    {outdated && <section className="resolution-review"><p className="form-error" role="alert">原文已修正，输入已保留。核对后可继续保存。</p><Button className="text-button" busy={reviewBusy} onClick={reviewSources}>核对最新原文</Button>{review && <><div className="resolution-review-lines">{review.lines.length ? review.lines.map(line => <blockquote key={line.id}><time>{formatTime(line.startMs)}</time><p>{line.text}</p></blockquote>) : <p>当前没有关联原文，也没有找到需核对的修正发言。{retrospective ? '请确认这份记录仍符合这次会议的原意。' : '请确认这份记录仍适用于当前讨论。'}</p>}</div>{reviewOutdated && <p className="form-error">原文又有修正，请重新核对。</p>}<Button onClick={acceptReview} disabled={reviewOutdated} busy={reviewBusy}>已核对，继续编辑</Button></>}<FormError error={reviewError} /></section>}
    <FormError error={error} /><div className="resolution-editor-actions">{!inline && cancelAction}<Button className="primary" type="submit" busy={busy} disabled={!text.trim() || outdated || reviewBusy}>保存记录</Button>{inline && cancelAction}</div>
  </form>;
  return inline ? form : <Modal title={retrospective ? '补充复盘记录' : item.resolution ? '编辑讨论记录' : '记下讨论结果'} onClose={onClose} closeDisabled={busy || reviewBusy}>{form}</Modal>;
}

export function ResolutionDialog(props) { return <ResolutionEditor {...props} />; }

function QuestionEvidence({ item, meeting, onEvidence, onTopic, onRead, showRecord = true }) {
  const sources = questionSources(item);
  const topic = meeting.topics?.find(topic => topic.id === item.topicId);
  const fullQuestion = !sameText(questionFor(item), item.question) && item.question;
  return <details className="focus-evidence" onToggle={event => { if (event.currentTarget.open) onRead?.(); }}>
    <summary>核对原话{sources.length > 0 ? ` · ${sources.length} 段` : ''}<ChevronDown size={13} aria-hidden="true" /></summary>
    <div className="focus-evidence-body">
      {sources.length > 0 ? <div className="focus-quotes">{sources.map((source, index) => <div className="focus-quote" key={source.id}>
        <button type="button" className="focus-quote-link" onClick={() => onEvidence(source.id)} title="定位这段原话并回听">原话 {index + 1}<ArrowUpRight size={13} aria-hidden="true" /></button>
        {source.quotes.length > 0 && <blockquote>{source.quotes.map((quote, index) => <p key={index}>{quote}</p>)}</blockquote>}
      </div>)}</div> : <p className="focus-source-note">这条问题尚未关联原话。</p>}
      {showRecord && item.resolution && <section className="focus-record"><h4>已记下的讨论结果</h4><ResolutionSummary item={item} onEvidence={onEvidence} showProvenance={false} /></section>}
      {fullQuestion && <div className="focus-full-question"><span>完整问题</span><p>{fullQuestion}</p></div>}
      {topic && <div className="focus-source-meta"><button type="button" onClick={() => onTopic(topic.id)}>{topic.title}<ChevronRight size={12} aria-hidden="true" /></button></div>}
    </div>
  </details>;
}

function ClarificationReading({ item, retrospective = false }) {
  const clarification = item.clarification?.stale ? null : item.clarification;
  const explanation = textValue(clarification?.explanation);
  const distinctions = (clarification?.distinctions || []).filter(value => !value.stale && textValue(value.title) && textValue(value.text));
  const manualReason = item.manualFields?.includes('discussionValue') || ['host', 'agent'].includes(item.author);
  const reason = (manualReason ? textValue(item.discussionValue) : '') || textValue(item.rationale) || textValue(item.discussionValue) || (!explanation ? textValue(item.impact) : '');
  const impact = textValue(item.impact);
  const separateImpact = impact && !sameText(impact, reason) && !sameText(impact, explanation);
  return <>
    {reason && <p className="focus-value">{reason}</p>}
    {distinctions.length > 0 && <div className={`focus-meanings ${distinctions.length === 2 ? 'has-two' : distinctions.length === 3 ? 'has-three' : 'is-list'}`}>
      {distinctions.map((distinction, index) => <section className="focus-meaning" key={distinction.id || index}>
        <h4>{distinction.title}</h4><p>{distinction.text}</p>
        {textValue(distinction.example) && <p className="focus-meaning-example">{distinction.example}</p>}
      </section>)}
    </div>}
    {explanation ? <section className="focus-interpretation" aria-label={retrospective ? 'AI 对这次讨论的解释' : 'AI 建议的澄清解释'}>
      <p className="focus-interpretation-label">{retrospective ? '回看这次讨论 · AI 解释' : '可以这样理解 · AI 建议'}</p>
      <blockquote><p className="focus-explanation">{explanation}</p>{separateImpact && <p className="focus-impact">{impact}</p>}</blockquote>
    </section> : separateImpact && <p className="focus-legacy-impact">{impact}</p>}
  </>;
}

function RetrospectiveOutcome({ item }) {
  const resolution = item.resolution;
  if (!resolution) return null;
  const isMeetingResult = resolution.author === 'ai';
  const review = clarificationRecordReview(item);
  const outcome = resolution.complete === true || resolution.complete !== false && item.status === 'resolved' ? '已说清' : resolution.complete === false ? '仍有未定的部分' : '';
  return <section className="focus-meeting-outcome">
    <h4>{isMeetingResult ? '会上最后说到' : '补充的复盘记录'}{isMeetingResult && outcome && <span>{outcome}</span>}</h4>
    <p>{resolution.text}</p>
    {review && <p className="record-review-state" role="status">{review === 'source_changed' ? '引用的原文已修改，请核对这条记录。' : '原文有更新，这条记录待核对。'}</p>}
  </section>;
}

function PrioritySignal({ item, meeting, compact = false }) {
  const priority = focusPriority(item, meeting);
  return <span className={`focus-priority-signal ${priority.level}${compact ? ' compact' : ''}`}>
    <span className="focus-priority-bars" aria-hidden="true">{[1, 2, 3].map(value => <i key={value} className={value <= priority.rank ? 'filled' : ''} />)}</span>
    <span>{priority.label}</span>
  </span>;
}

function FocusNavigator({ meeting, items, availableCount, current, readingId, recommendedId, returnTarget, disabled, onMove, onSelect, onOpenList, onReturn, onSources, requestQuestion }) {
  const retrospective = meeting.source === 'recording_import';
  const [open, setOpen] = useState(null);
  const navigation = useRef(null), popover = useRef(null), listTrigger = useRef(null), priorityTrigger = useRef(null);
  const popoverId = useId(), titleId = useId();
  const index = items.findIndex(item => item.id === readingId);
  const count = index < 0 ? availableCount : items.length;
  const priority = focusPriority(current, meeting);
  const hasPriority = priority.level !== 'unrated';
  const reason = textValue(priority.reason);
  const returnFocus = () => (open === 'priority' ? priorityTrigger.current : listTrigger.current)?.focus({ preventScroll: true });
  const close = (restore = false) => { if (restore) returnFocus(); setOpen(null); };
  function toggle(kind) {
    if (open === kind) { close(true); return; }
    if (kind === 'list') onOpenList();
    setOpen(kind);
  }
  useLayoutEffect(() => {
    const element = popover.current;
    if (!element || !open) return;
    function position() {
      const bounds = navigation.current.getBoundingClientRect();
      const width = Math.min(open === 'list' ? 560 : 390, innerWidth - 32);
      const left = open === 'list' ? bounds.left : bounds.right - width;
      const top = Math.min(bounds.bottom + 8, innerHeight - 160);
      Object.assign(element.style, { width: `${width}px`, left: `${Math.max(16, Math.min(left, innerWidth - width - 16))}px`, top: `${Math.max(16, top)}px`, maxHeight: `${innerHeight - Math.max(16, top) - 16}px` });
    }
    position(); element.showPopover();
    const target = element.querySelector('[aria-current="true"]') || element.querySelector('button') || element;
    target.focus({ preventScroll: true });
    if (open === 'list' && target !== element) element.scrollTop = Math.max(0, target.getBoundingClientRect().top - element.getBoundingClientRect().top - (element.clientHeight - target.offsetHeight) / 2);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); if (element.matches(':popover-open')) element.hidePopover(); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);
  return <div className="focus-navigation-shell">
    <nav className="focus-navigation" aria-label={retrospective ? '复盘焦点导航' : '焦点问题导航'} ref={navigation}>
      <div className="focus-navigation-steps">
        <button type="button" className="focus-step" aria-label="上一题" disabled={disabled || index <= 0} onClick={() => onMove(-1)}><ChevronLeft size={16} aria-hidden="true" /><span>上一题</span></button>
        <button type="button" className="focus-position" ref={listTrigger} aria-label={`${retrospective ? '全部复盘焦点' : '全部待讨论问题'}，${index < 0 ? `共 ${count} 题` : `第 ${index + 1} 题，共 ${count} 题`}`} aria-haspopup="dialog" aria-expanded={open === 'list'} aria-controls={open === 'list' ? popoverId : undefined} disabled={disabled || !availableCount} onClick={() => toggle('list')}>
          <span>{index < 0 ? `${retrospective ? '待回看' : '待讨论'} · ${count}` : `${index + 1} / ${count}`}</span><ChevronDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="focus-step" aria-label="下一题" disabled={disabled || index < 0 || index >= items.length - 1} onClick={() => onMove(1)}><span>下一题</span><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <div className="focus-navigation-context">
        <div className="focus-priority-slot">{current && <button type="button" className="focus-priority-trigger" ref={priorityTrigger} aria-label={`${priority.label}，查看排序说明`} aria-haspopup="dialog" aria-expanded={open === 'priority'} aria-controls={open === 'priority' ? popoverId : undefined} disabled={disabled} onClick={() => toggle('priority')}><PrioritySignal item={current} meeting={meeting} /></button>}</div>
        <div className="focus-return-slot">{returnTarget && <button type="button" className="focus-navigation-return" aria-label={retrospective ? '回到推荐的复盘焦点' : '回到推荐问题'} disabled={disabled} onClick={() => { close(); onReturn(); }}><ArrowLeft size={13} aria-hidden="true" /><span>回到推荐</span></button>}</div>
      </div>
    </nav>
    {open && <div id={popoverId} ref={popover} popover="auto" tabIndex={-1} role="dialog" aria-labelledby={titleId} className={`focus-navigation-popover ${open === 'list' ? 'focus-list-popover' : 'focus-priority-popover'}`} onToggle={event => { if (event.newState === 'closed') setOpen(null); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(true); } }}>
      {open === 'list' ? <>
        <div className="focus-list-heading"><h4 id={titleId}>{retrospective ? '复盘焦点' : '待讨论的问题'}</h4><span>{items.length} 个</span></div>
        <div className="focus-list-items">{items.map(item => <button type="button" className="focus-list-item" key={item.id} aria-current={item.id === readingId ? 'true' : undefined} onClick={() => { close(); onSelect(item.id); }}>
          <span className="focus-list-copy"><span className="focus-list-question">{questionFor(item)}</span>{(item.id === readingId || item.id === recommendedId) && <span className="focus-list-markers">{item.id === readingId && <span>正在查看</span>}{item.id === recommendedId && <span>AI 推荐</span>}</span>}</span><PrioritySignal item={item} meeting={meeting} compact />
        </button>)}</div>
        {requestQuestion && <div className="focus-list-footer" onClick={() => close(true)}>{requestQuestion}</div>}
      </> : <>
        <h4 id={titleId}>{hasPriority ? '为什么这样排序' : '还没有排序建议'}</h4>
        <p>{hasPriority ? reason || (retrospective ? 'AI 根据这次讨论中值得回看的误解和取舍，建议复盘顺序。' : 'AI 根据问题对当前讨论的影响，大致建议先后顺序。') : '这条问题尚未给出优先级，之后分析时会一并判断。'}</p>
        {hasPriority && <span className="focus-priority-note">{retrospective ? 'AI 对复盘先后的建议' : 'AI 对讨论先后的建议'}</span>}
        <button type="button" className="focus-priority-source" onClick={() => { close(); onSources(); }}>核对这题的原话<ArrowUpRight size={13} aria-hidden="true" /></button>
      </>}
    </div>}
  </div>;
}

function ClarificationPanel({ meeting, selected, setSelected, onEvidence, onTopic, mutate, job, analysisStatus, onRequestQuestion, questionRequestBusy = false, pauseFollowing = false, visible = true }) {
  const retrospective = meeting.source === 'recording_import';
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const recordTrigger = useRef(null);
  const focusHeading = useRef(null);
  const readingScroll = useRef(null);
  const [following, setFollowing] = useState(true);
  const [orderIds, setOrderIds] = useState(null);
  const active = orderedFocuses(meeting);
  const orderedIds = browseFocusIds(meeting, orderIds);
  const navigationItems = orderedIds.map(id => active.find(item => item.id === id)).filter(Boolean);
  const recommendedId = recommendedFocusId(meeting);
  const readingId = readingFocusId(meeting, selected, following, Boolean(editingItem) || pauseFollowing);
  const returnTarget = returnFocusId(meeting, readingId);
  const selectedItem = (meeting.followups || []).find(item => item.id === readingId);
  const current = isReadingFocus(selectedItem, meeting) ? selectedItem : null;

  useEffect(() => {
    if (selected !== readingId) setSelected(readingId);
  }, [readingId, selected, setSelected]);
  useLayoutEffect(() => {
    // Automatic advancement can reach a question added after manual browsing
    // began. Bring that new recommendation into the navigation order as well.
    if (following && !editingItem && !pauseFollowing && current && orderIds !== null && !orderedIds.includes(readingId)) {
      setOrderIds(active.map(item => item.id));
    }
  }, [following, editingItem, pauseFollowing, current, orderIds, orderedIds, readingId, active]);
  function freezeOrder() { if (orderIds === null) setOrderIds(active.map(item => item.id)); }
  function holdReading() { freezeOrder(); setSelected(readingId); setFollowing(false); }
  function toReadingTop() {
    requestAnimationFrame(() => {
      readingScroll.current?.scrollTo({ top: 0, behavior: 'instant' });
      focusHeading.current?.focus({ preventScroll: true });
    });
  }
  function selectQuestion(id) { freezeOrder(); setFollowing(id === recommendedId); setSelected(id); toReadingTop(); }
  function moveQuestion(direction) {
    const index = orderedIds.indexOf(readingId);
    const id = index < 0 ? null : orderedIds[index + direction];
    if (id) selectQuestion(id);
  }
  function openSources() {
    holdReading();
    const detail = readingScroll.current?.querySelector('.focus-evidence');
    if (detail) {
      detail.open = true;
      requestAnimationFrame(() => {
        const viewport = readingScroll.current;
        if (viewport) viewport.scrollTo({ top: viewport.scrollTop + detail.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12, behavior: 'instant' });
        detail.querySelector('summary')?.focus({ preventScroll: true });
      });
    }
  }
  useEffect(() => { readingScroll.current?.scrollTo({ top: 0, behavior: 'instant' }); }, [readingId]);
  function showEvidence(id) { holdReading(); onEvidence(id); }
  function editResult(item) { setSelected(readingId); setEditingItem(item); }
  function returnToRecommended() {
    if (!returnTarget) return;
    setFollowing(true);
    setOrderIds(null);
    setSelected(returnTarget);
    toReadingTop();
  }
  async function ignore(id) {
    setUpdating(id); setError('');
    try {
      const updated = await mutate(`/followups/${id}`, 'PATCH', { status: 'ignored' });
      setSelected(recommendedFocusId(updated));
      setOrderIds(null);
      setFollowing(true);
      toReadingTop();
    } catch (failure) { setError(failure.message); } finally { setUpdating(''); }
  }
  const selectedResult = selectedItem?.resolution && (['resolved', 'recorded'].includes(selectedItem.status) || selectedItem.attention?.needed === false);
  const staleResult = selectedResult && clarificationRecordReview(selectedItem) === 'source_changed';
  const importing = meeting.jobs?.some(item => item.type === 'import' && ['queued', 'running'].includes(item.status));
  const analyzing = ['submitting', 'queued', 'running'].includes(analysisStatus?.status) || job || meeting.jobs?.some(item => ['organize', 'followup', 'minutes'].includes(item.type) && ['queued', 'running'].includes(item.status));
  const emptyState = importing || !meeting.transcriptRevision ? {
    title: '等待录音转录', text: retrospective ? '录音转录完成后，再回看整场讨论。' : importing ? '录音正在处理，获得原文后开始分析。' : '开始录音或导入录音后，从实际发言中寻找值得讨论的问题。',
  } : analysisStatus?.status === 'error' ? {
    title: retrospective ? '本次复盘未完成' : '本次分析未完成', text: retrospective ? `${meeting.topics?.length ? '已完成的主题整理、原文和人工修正' : '原文和人工修正'}已保留，可以重试继续复盘。` : '可以根据上方提示重试，原文和人工修正会保留。',
  } : analyzing ? {
    title: retrospective ? analysisStatus?.status === 'submitting' ? '正在提交复盘' : analysisStatus?.status === 'queued' ? '等待开始复盘' : analysisStatus?.progress?.phase === 'retrospective_focus' ? '正在整理复盘焦点' : '正在梳理整场讨论' : analysisStatus?.status === 'submitting' ? '正在提交分析' : analysisStatus?.status === 'queued' ? '等待开始分析' : '正在分析讨论', text: retrospective ? '回看不同理解是怎样形成的，以及会上最后说清了什么。' : '从原文中检查不同理解、隐含前提和取舍。',
  } : !meeting.processedRevision ? {
    title: retrospective ? '等待复盘这次会议' : '等待分析这次讨论', text: retrospective ? '原文已保存，可从会议菜单开始复盘。' : '原文已保存，可从会议菜单重新分析。',
  } : meeting.processedRevision < meeting.transcriptRevision ? {
    title: retrospective ? '原文有更新，等待重新复盘' : '有新原文，等待更新分析', text: retrospective ? '复盘完成后再查看更新后的焦点。' : '整理完成后再查看新的问题。',
  } : {
    title: retrospective ? '暂时没有复盘焦点' : '可以继续讨论', text: retrospective ? '可以先回看讨论脉络，了解会上如何得出结论。' : '暂时没有需要停下来澄清的问题。',
  };
  const requestQuestion = onRequestQuestion && <Button className="text-button focus-request" onClick={onRequestQuestion} disabled={questionRequestBusy || !meeting.transcriptRevision} busy={questionRequestBusy}>{retrospective ? '请 AI 补充复盘焦点' : '请 AI 再提问'}</Button>;
  const closeEditor = () => { setEditingItem(null); requestAnimationFrame(() => (recordTrigger.current || focusHeading.current)?.focus({ preventScroll: true })); };
  const readingState = current ? 'active' : selectedResult ? (staleResult ? 'saved-stale' : 'saved') : selectedItem ? 'previous' : 'empty';
  return <div className="clarification-content reading-focus">
    {visible && <FocusNavigator meeting={meeting} items={navigationItems} availableCount={active.length} current={current} readingId={readingId} recommendedId={recommendedId} returnTarget={returnTarget} disabled={Boolean(editingItem) || pauseFollowing || Boolean(updating)} onMove={moveQuestion} onSelect={selectQuestion} onOpenList={() => setOrderIds(active.map(item => item.id))} onReturn={returnToRecommended} onSources={openSources} requestQuestion={requestQuestion} />}
    <FormError error={error} />
    <div className="clarification-scroll" ref={readingScroll}>
      <div className="focus-reading-view" key={`${readingId || 'none'}:${readingState}`}>
      {current ? <article className="focus-question">
        {(current.author === 'agent' || current.author === 'host' || current.pendingReview || current.sourceRevision < meeting.transcriptRevision) && <p className="focus-origin">{current.author === 'agent' ? retrospective ? 'Agent 补充' : 'Agent 提问' : current.author === 'host' ? retrospective ? '主持人补充' : '主持人提问' : null}{(current.pendingReview || current.sourceRevision < meeting.transcriptRevision) && <span role="status">{retrospective ? '原文有更新，待复核' : '有新发言，待复核'}</span>}</p>}
        <h3 ref={focusHeading} tabIndex={-1}>{questionFor(current)}</h3>
        <ClarificationReading item={current} retrospective={retrospective} />
        {retrospective && <RetrospectiveOutcome item={current} />}
        <QuestionEvidence key={current.id} item={current} meeting={meeting} onEvidence={showEvidence} onTopic={onTopic} onRead={holdReading} showRecord={!retrospective} />
        {!editingItem && <div className="focus-actions"><Button ref={recordTrigger} className="primary" onClick={() => editResult(current)}>{retrospective ? '补充复盘记录' : '记下讨论结果'}</Button><Button className="text-button" disabled={updating === current.id} onClick={() => ignore(current.id)}>{retrospective ? '暂不关注' : '先放下'}</Button></div>}
      </article> : selectedResult ? <article className={`focus-saved${staleResult ? ' is-stale' : ''}`}><p className="focus-origin" role="status">{staleResult ? '此前的问题' : retrospective ? '复盘记录已保留' : selectedItem.attention?.needed === false ? '已退出当前提示，讨论记录已保留' : '已保存到讨论进展'}</p><h3 ref={focusHeading} tabIndex={-1}>{questionFor(selectedItem)}</h3><ResolutionSummary item={selectedItem} retrospective={retrospective} onEvidence={showEvidence} onEdit={editingItem ? undefined : () => editResult(selectedItem)} /></article> : selectedItem && (selectedItem.stale || selectedItem.status !== 'active' || selectedItem.attention?.needed === false) ? <div className="clarification-transition"><h3>{selectedItem.stale ? '刚才的问题需要重新核对' : selectedItem.status === 'ignored' ? retrospective ? '这条焦点已暂不关注' : '这条问题已先放下' : selectedItem.attention?.needed === false ? '这条问题暂时不需要继续提示' : '刚才的问题已处理'}</h3><p>{selectedItem.stale ? '原文已修正，更新后再查看。' : selectedItem.attention?.needed === false ? textValue(selectedItem.attention.reason) || (retrospective ? '可以回看其他复盘焦点。' : '可以回到当前讨论。') : retrospective ? '可以回看其他复盘焦点。' : '可以回到当前讨论。'}</p></div> : <EmptyState title={emptyState.title} action={!active.length && !importing && !analyzing && meeting.processedRevision ? requestQuestion : null}>{emptyState.text}</EmptyState>}
      </div>
      {editingItem && <ResolutionEditor key={editingItem.id} inline item={(meeting.followups || []).find(item => item.id === editingItem.id) || editingItem} meeting={meeting} mutate={mutate} onClose={closeEditor} />}

    </div>
    {job && <div className="working-line"><LoaderCircle size={13} className="spin" />{retrospective ? '正在整理复盘焦点…' : '正在寻找新的问题…'}</div>}
  </div>;
}

function ProgressPanel({ meeting, onEvidence, onResolve }) {
  const retrospective = meeting.source === 'recording_import';
  const records = (meeting.followups || []).filter(item => !item.mergedInto && ['active', 'resolved', 'recorded'].includes(item.status) && item.resolution);
  const unrecorded = (meeting.followups || []).filter(item => !item.mergedInto && item.status === 'resolved' && !item.resolution);
  const ignored = (meeting.followups || []).filter(item => !item.mergedInto && item.status === 'ignored');
  const merged = (meeting.followups || []).filter(item => item.mergedInto);
  return <div className="progress-content"><div className="progress-scroll">
    {!records.length ? <EmptyState compact title={retrospective ? '还没有复盘记录' : '还没有讨论记录'}>{retrospective ? '整理出的会末结果和你补充的复盘记录会保存在这里。' : '在问题下方记下讨论结果，会保存在这里。'}</EmptyState> : records.map(item => <article className="progress-card" key={item.id}><h3 className="progress-question">{questionFor(item)}</h3><ResolutionSummary item={item} retrospective={retrospective} compact onEvidence={onEvidence} onEdit={onResolve} /></article>)}
    {(unrecorded.length > 0 || ignored.length > 0 || merged.length > 0) && <details className="processed-clarifications"><summary>其他已处理问题 · {unrecorded.length + ignored.length + merged.length}</summary>{unrecorded.map(item => <div key={item.id}><span>已处理，未记录结果</span><p>{item.question}</p><Button className="text-button small" onClick={() => onResolve(item.id)}><Pencil size={11} />补记结果</Button></div>)}{ignored.map(item => <div key={item.id}><span>{retrospective ? '暂不关注' : '已先放下'}</span><p>{item.question}</p></div>)}{merged.map(item => <div key={item.id}><span>已并入其他问题</span><p>{item.question}</p>{item.resolution && <ResolutionSummary item={item} retrospective={retrospective} compact onEvidence={onEvidence} />}</div>)}</details>}
  </div></div>;
}

const MemoClarificationPanel = memo(ClarificationPanel);
const MemoProgressPanel = memo(ProgressPanel);
export { MemoClarificationPanel as ClarificationPanel, MemoProgressPanel as ProgressPanel };
