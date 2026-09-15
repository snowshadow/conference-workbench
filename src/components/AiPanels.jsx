import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowUp, ChevronDown, LoaderCircle, MessageCircle, RefreshCw } from 'lucide-react';
import { Button, EmptyState, Evidence, FormError } from './ui.jsx';
import { formatTime } from '../lib/api.js';
import { questionFeedback, questionProgressLabel, questionRequestKey } from '../../shared/question-feedback.js';

export function MeetingMarkdown({ children, onEvidence }) {
  return <ReactMarkdown components={{ a: ({ href, children: label }) => href?.startsWith('#transcript:') ? <button className="markdown-citation" onClick={() => onEvidence(decodeURIComponent(href.slice(12)))}>{label}</button> : <a href={href} target="_blank" rel="noreferrer">{label}</a> }}>{String(children || '')}</ReactMarkdown>;
}

function QuestionPanel({ meeting, onEvidence, askScope, setAskScope, inputRef, submitJob }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scroll = useRef(null);
  const following = useRef(true);
  const programmaticScrollTop = useRef(null);
  const questions = meeting.questions || [];
  const feedback = questionFeedback(meeting.jobs, questions);
  const feedbackKey = feedback.map(item => item.id).join(',');
  const questionPending = feedback.some(job => ['queued', 'running'].includes(job.status)
    && questionRequestKey(job.input) === questionRequestKey({ question, topicId: askScope }));
  const topics = (meeting.topics || []).filter(topic => !topic.mergedInto);
  useEffect(() => { if (askScope && !topics.some(topic => topic.id === askScope)) setAskScope(''); }, [askScope, topics, setAskScope]);
  useEffect(() => {
    const container = scroll.current;
    if (!following.current || !container) return;
    const items = container.querySelectorAll('.qa-card');
    const latest = items[items.length - 1];
    if (!latest) return;
    const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + latest.getBoundingClientRect().top - container.getBoundingClientRect().top));
    if (Math.abs(container.scrollTop - top) > 1) { programmaticScrollTop.current = top; container.scrollTop = top; }
  }, [questions.length, feedbackKey]);
  function trackReading(event) {
    const node = event.currentTarget;
    if (programmaticScrollTop.current !== null) {
      const expected = programmaticScrollTop.current;
      programmaticScrollTop.current = null;
      if (Math.abs(node.scrollTop - expected) < 2) return;
    }
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 50;
  }
  async function submit(event) {
    event?.preventDefault();
    if (!question.trim() || busy || questionPending) return;
    const submittedDraft = question;
    setBusy(true); setError('');
    try { await submitJob('answer', { question: submittedDraft.trim(), ...(askScope ? { topicId: askScope } : {}) }); setQuestion(current => current === submittedDraft ? '' : current); following.current = true; } catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  function prepareRetry(item) {
    setQuestion(item.question || '');
    setAskScope(item.topicId || '');
    setError('');
    inputRef.current?.focus({ preventScroll: true });
  }
  return <div className="question-content">
    <div className="question-scroll" ref={scroll} onScroll={trackReading}>
      {!questions.length && !feedback.length ? <EmptyState compact icon={MessageCircle} title="向这场会议提问">回顾讨论依据、比较不同说法，或找出还没有验证的前提。回答只依据本次会议。</EmptyState> : questions.map(item => <article className="qa-card" key={item.id}>
        <h3 className="qa-question">{item.question}</h3>
        {item.topicId && <p className="qa-scope">关于：{meeting.topics?.find(topic => topic.id === item.topicId)?.title || '指定主题'}</p>}
        <div className="qa-answer"><MeetingMarkdown onEvidence={onEvidence}>{item.answer}</MeetingMarkdown>
          {item.inference && <div className="ai-inference"><span>AI 推断</span><MeetingMarkdown onEvidence={onEvidence}>{item.inference}</MeetingMarkdown></div>}
        </div>
        {(item.evidenceIds?.length > 0 || Number.isFinite(item.sourceThroughMs)) && <div className="qa-source-row">
          {item.evidenceIds?.length > 0 && <details className="qa-provenance">
            <summary>查看依据 · {item.evidenceIds.length} 处<ChevronDown size={12} aria-hidden="true" /></summary>
            <Evidence ids={item.evidenceIds} onSelect={onEvidence} />
          </details>}
          {Number.isFinite(item.sourceThroughMs) && <span className="qa-cutoff">回答截至 {formatTime(item.sourceThroughMs)}</span>}
        </div>}
        {(item.stale || item.sourceRevision < meeting.transcriptRevision) && <div className={`qa-freshness${item.stale ? ' source-changed' : ''}`}>
          <span>{item.stale ? '引用的原文已修改，请重新核对回答。' : '回答后有新发言'}</span>
          <button onClick={() => prepareRetry(item)}>重新提问 <RefreshCw size={11} aria-hidden="true" /></button>
        </div>}
      </article>)}
      {feedback.map(item => <article className="qa-card qa-job" key={item.id}>
        <h3 className="qa-question">{item.input?.question || '会议提问'}</h3>
        {item.input?.topicId && <div className="qa-scope">关于：{topics.find(topic => topic.id === item.input.topicId)?.title || '指定主题'}</div>}
        {['queued', 'running'].includes(item.status)
          ? <div className="qa-pending" role="status"><LoaderCircle size={13} className="spin" /><span>{questionProgressLabel(item)}</span></div>
          : <div className="qa-failed"><p role="alert">{typeof item.error === 'string' && item.error.trim() ? item.error : '这次回答未能完成，请重新提问。'}</p><button className="text-button" onClick={() => prepareRetry(item.input || {})}>重新提问 <RefreshCw size={11} /></button></div>}
      </article>)}
    </div>
    <form className="question-composer" onSubmit={submit}><FormError error={error} /><div className="composer-scope"><select aria-label="提问范围" value={askScope} onChange={event => setAskScope(event.target.value)}><option value="">整场会议</option>{topics.map(topic => <option value={topic.id} key={topic.id}>{topic.title}</option>)}</select><span>公开回答</span></div><textarea ref={inputRef} value={question} onChange={event => setQuestion(event.target.value)} placeholder="例如：这个决定依赖哪些前提？" rows={2} maxLength={4000} aria-label="向会议提问" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><Button className="primary send-question" type="submit" busy={busy} disabled={!question.trim() || questionPending} aria-label={questionPending ? '这个问题正在回答' : '发送问题'}>{!busy && <ArrowUp size={16} />}</Button></div></form>
  </div>;
}

const MemoQuestionPanel = memo(QuestionPanel);
export { MemoQuestionPanel as QuestionPanel };
