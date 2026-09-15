import { memo, useEffect, useRef, useState } from 'react';
import { ArrowDown, AudioLines, FilePenLine, Headphones, LoaderCircle, MoreHorizontal, Pencil, Play, Plus, Search, UsersRound, X } from 'lucide-react';
import { api, formatTime, meetingPath } from '../lib/api.js';
import { searchTextParts } from '../lib/search-text-parts.js';
import { Button, EmptyState, FormError, IconButton, Modal, useFormAction } from './ui.jsx';
import PeopleDialog from './PeopleDialog.jsx';
import { participantFor, speakerName as participantName, isUnassignedUtterance } from '../../shared/people.js';
import '../transcript-tools.css';
import '../transcript-search.css';

function HighlightedText({ text, query }) {
  return searchTextParts(text, query).map(part => part.matched
    ? <mark className="transcript-search-match" key={part.start}>{part.text}</mark>
    : part.text);
}

export function speakerName(id, meeting) { return participantFor(id, meeting) ? participantName(id, meeting) : meeting.speakerLabels?.[id] || '未知说话人'; }

function speakerButtonTitle(line, meeting) {
  const person = participantFor(line.participantId, meeting);
  if (!person || isUnassignedUtterance(person)) return '标记这段发言是谁说的';
  const name = speakerName(person.id, meeting);
  return person.identitySource === 'voiceprint' ? `声音自动识别为${name}，点击确认或纠正` : `查看或修改${name}的说话人设置`;
}

function TranscriptForm({ meeting, line, focusSpeaker = false, onClose, mutate }) {
  const formRef = useRef(null);
  const [text, setText] = useState(line?.text || '');
  const [participantId, setParticipant] = useState(isUnassignedUtterance(participantFor(line?.participantId, meeting)) ? '' : line?.participantId || '');
  const [newName, setNewName] = useState('');
  useEffect(() => { formRef.current?.querySelector(focusSpeaker ? 'select' : 'textarea')?.focus({ preventScroll: true }); }, [focusSpeaker]);
  const { submit, error, busy } = useFormAction(async () => {
    let target = participantId;
    if (target === 'new') {
      const person = await api(meetingPath(meeting.id, '/participants'), { method: 'POST', body: { name: newName.trim() } });
      target = person.id; setParticipant(person.id);
    }
    let savedLine = line;
    if (!line || text.trim() !== line.text) savedLine = await mutate(line ? `/transcript/${line.id}` : '/transcript', line ? 'PATCH' : 'POST', { text: text.trim() });
    if (target && target !== line?.participantId) await mutate(`/transcript/${savedLine.id}/participant`, 'PATCH', { participantId: target });
    onClose();
  });
  return <Modal title={focusSpeaker ? '这段发言是谁说的？' : line ? '修正这段发言' : '补录遗漏发言'} subtitle={focusSpeaker ? undefined : line ? '修正后，相关的 AI 内容会重新整理。' : '仅补录会议中实际说过、但转录遗漏的内容。保存后标为「手动原文」，并作为 AI 分析的依据。'} onClose={onClose} closeDisabled={busy}>
    <form ref={formRef} onSubmit={submit}>
      <label>这段发言是谁说的？<select autoFocus={focusSpeaker} value={participantId} onChange={event => setParticipant(event.target.value)}>{(!line?.participantId || isUnassignedUtterance(participantFor(line?.participantId, meeting))) && <option value="">不确定，暂不标记</option>}{(meeting.participants || []).filter(person => !person.mergedInto && !isUnassignedUtterance(person)).map(person => <option key={person.id} value={person.id}>{participantName(person.id, meeting)}</option>)}<option value="new">新增一位说话人</option></select></label>
      {participantId === 'new' && <label>姓名<input value={newName} onChange={event => setNewName(event.target.value)} maxLength={100} placeholder="填写这位参会者的姓名" required /></label>}
      <label>原文<textarea autoFocus={!focusSpeaker} value={text} onChange={event => setText(event.target.value)} placeholder="输入会议中实际说过的内容…" rows={focusSpeaker ? 3 : 7} required maxLength={12000} /></label><FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="primary" busy={busy} disabled={!text.trim() || participantId === 'new' && !newName.trim() || focusSpeaker && !participantId}>{focusSpeaker ? '保存说话人' : line ? '保存修正' : '保存发言'}</Button></div>
    </form>
  </Modal>;
}

function TranscriptPanel({ meeting, lines, total, onLoadEarlier, loadingEarlier, partial, focusedLine, onFocusLine, clearFocus, mutate, locating, visible = true, focusSearchRequest = 0 }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [modal, setModal] = useState(null);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef(null);
  const audioRef = useRef(null);
  const searchInputRef = useRef(null);
  const moreRef = useRef(null);
  const lastSearchFocusRequest = useRef(0);
  const previousAnchor = useRef(null);
  const lastScrollContent = useRef(null);
  const searchRequest = useRef(null);
  const searchSequence = useRef(0);
  const resultContext = useRef(null);
  const searchContext = useRef(null);
  const lastFocusedId = useRef(null);
  const lastPlayRequest = useRef(null);
  const playSequence = useRef(0);
  const [playRequest, setPlayRequest] = useState(null);
  useEffect(() => {
    if (!visible) { audioRef.current?.pause(); moreRef.current?.removeAttribute('open'); }
    const audio = audioRef.current;
    return () => audio?.pause();
  }, [visible]);
  useEffect(() => {
    if (!visible || !focusSearchRequest || lastSearchFocusRequest.current === focusSearchRequest) return;
    lastSearchFocusRequest.current = focusSearchRequest;
    searchInputRef.current?.focus({ preventScroll: true });
  }, [visible, focusSearchRequest]);
  useEffect(() => {
    const dismiss = event => { if (moreRef.current?.open && !moreRef.current.contains(event.target)) moreRef.current.removeAttribute('open'); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const searchKey = JSON.stringify([meeting.id, meeting.transcriptRevision, meeting.identityRevision, query]);
  searchContext.current = { key: searchKey, query, typedQuery: search.trim() };
  const cancelSearch = () => { searchRequest.current?.controller.abort(); searchRequest.current = null; };
  const beginSearch = key => {
    cancelSearch();
    const request = { key, sequence: ++searchSequence.current, controller: new AbortController() };
    searchRequest.current = request;
    return request;
  };
  const currentSearch = request => searchRequest.current === request && !request.controller.signal.aborted && searchContext.current.key === request.key && searchContext.current.query === searchContext.current.typedQuery;
  const changeSearch = value => {
    // Invalidate the old query immediately, including the debounce interval.
    cancelSearch(); setSearch(value); setSearching(false); setSearchError('');
    if (!value.trim()) { setQuery(''); setResult(null); resultContext.current = null; }
  };
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    cancelSearch();
    if (!query) { setResult(null); setSearchError(''); setSearching(false); resultContext.current = null; return; }
    // Activity preserves loaded pages. Reopening the panel must not reset an
    // unchanged search to its first page or move the reader back to the top.
    if (resultContext.current?.key === searchKey) { setSearching(false); return () => cancelSearch(); }
    if (query !== searchContext.current.typedQuery) return;
    const request = beginSearch(searchKey);
    setResult(null); resultContext.current = null;
    setSearching(true);
    api(`${meetingPath(meeting.id, '/transcript')}?q=${encodeURIComponent(query)}&limit=100`, { signal: request.controller.signal })
      .then(value => { if (currentSearch(request)) { resultContext.current = { key: request.key, data: value }; setResult(value); setSearchError(''); } })
      .catch(error => { if (currentSearch(request) && error.name !== 'AbortError') setSearchError(error.message); })
      .finally(() => { if (currentSearch(request)) { setSearching(false); searchRequest.current = null; } });
    return () => cancelSearch();
  }, [meeting.id, meeting.transcriptRevision, meeting.identityRevision, query, search]);
  async function loadMoreMatches() {
    const context = resultContext.current;
    if (searching || !query || query !== search.trim() || context?.key !== searchKey || context.data.nextCursor == null) return;
    const cursor = context.data.nextCursor;
    const request = beginSearch(searchKey);
    setSearching(true); setSearchError('');
    try {
      const next = await api(`${meetingPath(meeting.id, '/transcript')}?q=${encodeURIComponent(query)}&cursor=${cursor}&limit=100`, { signal: request.controller.signal });
      const previous = resultContext.current;
      if (!currentSearch(request) || previous?.key !== request.key || previous.data.nextCursor !== cursor) return;
      const seen = new Set(previous.data.lines.map(line => line.id));
      const combined = { ...next, lines: [...previous.data.lines, ...next.lines.filter(line => !seen.has(line.id))] };
      resultContext.current = { key: request.key, data: combined }; setResult(combined);
    } catch (error) { if (currentSearch(request) && error.name !== 'AbortError') setSearchError(error.message); }
    finally { if (currentSearch(request)) { setSearching(false); searchRequest.current = null; } }
  }
  useEffect(() => {
    if (!visible || !scrollRef.current) return;
    const previous = lastScrollContent.current;
    if (previous?.lines === lines && previous.partial === partial?.text && previous.query === query) return;
    lastScrollContent.current = { lines, partial: partial?.text, query };
    if (previousAnchor.current && lines.length > previousAnchor.current.lineCount) { scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousAnchor.current.height; previousAnchor.current = null; }
    else if (following && !focusedLine && !query) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, partial, following, focusedLine, query, visible]);
  useEffect(() => {
    if (!visible) return;
    if (!focusedLine) { lastFocusedId.current = null; return; }
    if (lastFocusedId.current === focusedLine.id) return;
    lastFocusedId.current = focusedLine.id;
    const row = scrollRef.current?.querySelector(`[data-line-id="${CSS.escape(focusedLine.id)}"]`);
    // Move only the transcript, never the discussion behind the floating tool.
    const container = scrollRef.current;
    if (row && container) {
      const bounds = row.getBoundingClientRect(), viewport = container.getBoundingClientRect();
      const delta = bounds.top < viewport.top || bounds.height > viewport.height ? bounds.top - viewport.top : bounds.bottom > viewport.bottom ? bounds.bottom - viewport.bottom : 0;
      if (delta) container.scrollTo({ top: container.scrollTop + delta, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    setFollowing(false);
  }, [focusedLine?.id, playRequest, visible]);
  const focusedRecording = focusedLine?.recordingId && (meeting.recordings || []).find(recording => recording.id === focusedLine.recordingId);
  const audioEnd = Math.min(focusedRecording?.sampleCount ?? Infinity, (focusedLine?.endSample || (focusedLine?.startSample || 0) + 32000) + 8000);
  const audioStart = Math.max(0, Math.min(audioEnd - 1, (focusedLine?.startSample || 0) - 8000));
  const audioUrl = focusedLine?.recordingId && audioEnd > audioStart ? `/api/recordings/${encodeURIComponent(focusedLine.recordingId)}/audio?startSample=${audioStart}&endSample=${audioEnd}` : null;
  useEffect(() => { setAudioError(''); }, [audioUrl]);
  useEffect(() => {
    if (!visible) return;
    if (!focusedLine) { lastPlayRequest.current = null; return; }
    if (!audioUrl || !focusedLine.play) return;
    const request = playRequest?.id === focusedLine.id ? playRequest : focusedLine.id;
    if (lastPlayRequest.current === request) return;
    const audio = audioRef.current;
    if (!audio) return;
    lastPlayRequest.current = request;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }, [audioUrl, focusedLine?.id, focusedLine?.play, playRequest, visible]);
  const selectLine = line => {
    lastFocusedId.current = null;
    setPlayRequest({ id: line.id, sequence: ++playSequence.current });
    onFocusLine({ ...line, play: Boolean(line.recordingId) });
  };
  const filtering = Boolean(search.trim());
  const matchingResult = query === search.trim() && resultContext.current?.key === searchKey ? result : null;
  const awaitingSearch = filtering && (searching || query !== search.trim() || !matchingResult && !searchError);
  const rows = filtering ? matchingResult?.lines || [] : lines;
  const gaps = (meeting.recordings || []).flatMap(recording => (recording.gaps || []).map(gap => ({ ...gap, recordingId: recording.id, startMs: gap.startMs ?? (recording.timelineStartMs || 0) + (gap.startSample || 0) / 16, endMs: gap.endMs ?? (recording.timelineStartMs || 0) + (gap.endSample || 0) / 16 })));
  const loadEarlier = () => { if (scrollRef.current) previousAnchor.current = { height: scrollRef.current.scrollHeight, lineCount: lines.length }; onLoadEarlier(); };
  return <div className="transcript-content">
    <div className="transcript-toolbar"><label className="search-field"><Search size={14} /><input ref={searchInputRef} aria-label="搜索会议原文" placeholder="搜索原文" value={search} onChange={event => changeSearch(event.target.value)} />{search && <button title="清除搜索" aria-label="清除搜索" type="button" onClick={() => changeSearch('')}><X size={13} /></button>}</label><span className="transcript-count">{filtering ? (awaitingSearch && !matchingResult ? '正在查找' : `${matchingResult?.total || 0} 条匹配`) : `${total} 段原文`}</span><Button className="text-button small" onClick={() => setModal({ mode: 'speakers' })}><UsersRound size={14} /><span>说话人</span></Button><details className="transcript-more" ref={moreRef} onKeyDown={event => { if (event.key === 'Escape' && moreRef.current?.open) { event.preventDefault(); event.stopPropagation(); moreRef.current.removeAttribute('open'); moreRef.current.querySelector('summary')?.focus(); } }}><summary title="更多原文操作" aria-label="更多原文操作"><MoreHorizontal size={17} /></summary><div className="transcript-more-popover"><Button className="text-button small" onClick={() => { moreRef.current?.removeAttribute('open'); setModal({ mode: 'add' }); }}><Plus size={14} />补录遗漏发言</Button><p>仅补录会议中实际说过的内容。</p></div></details></div>
    {gaps.length > 0 && <details className="gap-notice"><summary>{gaps.length} 处转录缺口 · 已保存的音频可回听</summary>{gaps.map((gap, index) => <div key={`${gap.recordingId}-${index}`}><span>{formatTime(gap.startMs ?? (gap.startSample || 0) / 16)} {gap.endMs || gap.endSample ? `– ${formatTime(gap.endMs ?? gap.endSample / 16)}` : '起'} · {gap.reason || '语音识别暂时中断'}</span><a href={`/api/recordings/${encodeURIComponent(gap.recordingId)}/audio?startSample=${gap.startSample || 0}${gap.endSample ? `&endSample=${gap.endSample}` : ''}`} target="_blank" rel="noreferrer">回听音频</a></div>)}</details>}
    {(focusedLine || locating) && <div className="source-focus" role="region" aria-label="引用原文"><div className="source-focus-heading"><span><Headphones size={14} />{locating ? '正在定位原文…' : `引用原文 · ${formatTime(focusedLine.startMs)} · ${speakerName(focusedLine.participantId || focusedLine.speakerId, meeting)}`}</span><IconButton title="收起引用" onClick={clearFocus}><X size={14} /></IconButton></div>{focusedLine && <><p>{focusedLine.text}</p>{focusedLine.timing === 'chunk' && <small className="chunk-timing-note">按录音段定位 · 该段原文没有逐句时间，回听包含整段录音。</small>}{audioUrl ? <audio ref={audioRef} key={audioUrl} controls preload="metadata" src={audioUrl} onError={() => setAudioError('这段录音暂时无法读取，请检查本地服务或重新定位原文。')} /> : <small>这条原文没有可回听的关联录音。</small>}{audioError && <p className="form-error">{audioError}</p>}{focusedRecording?.state === 'interrupted' && <small>录音曾中断，可回听已保存的部分。</small>}</>}</div>}
    <FormError error={searchError} />
    <div className="transcript-scroll" ref={scrollRef} onScroll={event => { const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 55); }}>
      {!filtering && total > lines.length && <button className="load-earlier" disabled={loadingEarlier} onClick={loadEarlier}>{loadingEarlier ? <LoaderCircle size={14} className="spin" /> : null}查看更早的原文（还有 {total - lines.length} 段）</button>}
      {!rows.length && (filtering || !partial?.text) ? <EmptyState compact icon={filtering ? Search : AudioLines} title={filtering ? (awaitingSearch ? '正在查找原文' : '没有找到匹配内容') : '原话是讨论的起点'}>{filtering ? (awaitingSearch ? null : '换一个词试试，搜索只覆盖本次会议。') : meeting.jobs?.some(job => job.type === 'import') ? '导入录音的定稿转录会显示在这里。也可以补充已经核对的会议原文。' : '开始录音后，定稿转录会按时间出现在这里。也可以补充已经核对的会议原文。'}</EmptyState> : rows.map(line => <div className={`transcript-line ${focusedLine?.id === line.id ? 'highlighted' : ''}`} key={line.id} data-line-id={line.id}>
        <button className="line-time" title={line.recordingId ? line.timing === 'chunk' ? '按录音段定位并回听' : '定位并回听这段原文' : '定位这段原文'} onClick={() => selectLine(line)}>{line.recordingId && <Play size={10} />}{formatTime(line.startMs)}</button><button className="line-speaker line-speaker-button" title={speakerButtonTitle(line, meeting)} onClick={() => setModal(line.participantId && !isUnassignedUtterance(participantFor(line.participantId, meeting)) ? { mode: 'speakers', participantId: line.participantId } : { mode: 'edit', line, focusSpeaker: true })}>{speakerName(line.participantId || line.speakerId, meeting)}</button><div className="line-text"><p><HighlightedText text={line.text} query={matchingResult ? query : ''} /></p>{line.timing === 'chunk' && <span className="source-badge chunk-timing-note"><Headphones size={10} />按录音段定位</span>}{!['asr', 'file-asr', 'import'].includes(line.origin) && <span className="source-badge"><FilePenLine size={10} />{line.origin === 'agent' ? 'Agent 原文' : '手动原文'}</span>}</div><IconButton title="修正原文" className="line-edit" onClick={() => setModal({ mode: 'edit', line })}><Pencil size={12} /></IconButton>
      </div>)}
      {filtering && matchingResult?.nextCursor != null && <button className="load-earlier" disabled={searching} onClick={loadMoreMatches}>加载更多匹配</button>}
      {!filtering && partial?.text && <div className="transcript-line partial-line"><span className="line-time"><span className="live-dot" /></span><span className="line-speaker">正在识别</span><div className="line-text"><p>{partial.text}<span className="typing-cursor" /></p></div></div>}
    </div>
    {!following && !filtering && rows.length > 0 && <button className="follow-live" onClick={() => { clearFocus(); setFollowing(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown size={12} />回到最新</button>}
    {visible && modal && modal.mode !== 'speakers' && <TranscriptForm meeting={meeting} line={modal.line} focusSpeaker={modal.focusSpeaker} onClose={() => setModal(null)} mutate={mutate} />}
    {visible && modal?.mode === 'speakers' && <PeopleDialog meeting={meeting} initialParticipantId={modal.participantId} onClose={() => setModal(null)} onChanged={() => mutate('', 'GET')} />}
  </div>;
}

export default memo(TranscriptPanel);
