import { lazy, Suspense, startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, AudioLines, Check, CheckCheck, CircleAlert, CircleHelp, GitBranch, LoaderCircle, Mic, Minimize2, MoreHorizontal, Palette, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, RefreshCw, Settings2, Sparkles, Target, Terminal, Upload, X } from 'lucide-react';
import { api, formatDate, formatTime, meetingPath } from './lib/api.js';
import { CaptureClient } from './lib/capture-client.js';
import TranscriptPanel from './components/TranscriptPanel.jsx';
import MeetingToolWindow from './components/MeetingToolWindow.jsx';
import { QuestionPanel } from './components/AiPanels.jsx';
import { ClarificationPanel, ProgressPanel, ResolutionDialog } from './components/ClarificationPanel.jsx';
import { AgentDialog, ImportDialog, MeetingDialog, MinutesDialog, ProcessingDialog, SettingsDialog } from './components/Dialogs.jsx';
import ImportStatus from './components/ImportStatus.jsx';
import DiscussionStatus, { latestDiscussionJob } from './components/DiscussionStatus.jsx';
import ThemeDialog from './components/ThemeDialog.jsx';
import { Button, EmptyState, IconButton, PanelErrorBoundary, ResizeHandle } from './components/ui.jsx';

const TopicPanel = lazy(() => import('./components/TopicPanel.jsx'));

function readLayout() {
  try { const saved = JSON.parse(localStorage.getItem('meeting-workbench:layout') || '{}'); return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}; } catch { return {}; }
}
function layoutSize(value, fallback, min, max) { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback; }

const statusLabels = { planned: '未开始', active: '进行中', ended: '已结束' };
const captureLabels = { idle: '未录音', recording: '正在录音', paused: '录音已暂停', interrupted: '录音中断' };
const asrLabels = { unconfigured: '转录未配置', connecting: '转录连接中', connected: '转录已连接', reconnecting: '转录重连中', error: '转录异常', stopped: '转录已停止' };
const jobLabels = { organize: '讨论整理', followup: '澄清检查', answer: '会议问答', minutes: '会议纪要', import: '录音导入' };

function initialMeetingId() { const linked = new URLSearchParams(location.search).get('meeting'); if (linked) return linked; try { return localStorage.getItem('meeting-workbench:selected') || null; } catch { return null; } }

function Sidebar({ meetings, archived, setArchived, selectedId, select, create, importRecording, settings, appearance, agent, locked, collapsed, setCollapsed, width, error }) {
  return <aside className={`sidebar ${collapsed ? 'compact-sidebar' : ''}`} style={{ width: collapsed ? 68 : width }}>
    <div className="brand"><div className="brand-mark"><img src="/logo-beaver.png" alt={collapsed ? '会议工作台' : ''} width="32" height="32" /></div>{!collapsed && <div><strong>会议工作台</strong></div>}</div>
    <Button className="new-meeting" onClick={create} disabled={locked} aria-label="新建会议" title={locked ? '先停止当前会议的录音，再创建新会议' : '创建会议'}><Plus size={17} />{!collapsed && '新建会议'}</Button>
    <Button className="import-meeting" onClick={importRecording} disabled={locked} title={locked ? '先停止当前录音，再导入会议录音' : '导入录音'}><Upload size={16} />{!collapsed && '导入录音'}</Button>
    {!collapsed && <><div className="sidebar-section-heading"><span>{archived ? '已归档' : '我的会议'}</span><button className="sidebar-archive-toggle" onClick={() => setArchived(!archived)} aria-label={archived ? '返回会议列表' : '查看已归档会议'}>{archived ? '返回会议' : '已归档'}</button></div><div className="meeting-list">
      {error ? <p className="sidebar-error">{error}</p> : meetings.length ? meetings.map(meeting => <div className={`meeting-list-item ${selectedId === meeting.id ? 'active' : ''}`} key={meeting.id}><button className="meeting-select" aria-current={selectedId === meeting.id ? 'page' : undefined} disabled={locked && selectedId !== meeting.id} onClick={() => select(meeting.id)} title={locked && selectedId !== meeting.id ? '先停止当前录音，再切换会议' : meeting.title}><div><strong>{meeting.title}</strong><span>{formatDate(meeting.createdAt)} · {statusLabels[meeting.status]}</span></div></button></div>) : <div className="sidebar-empty">{archived ? '归档的会议会保留在这里。' : '还没有会议，先创建一场。'}</div>}
    </div><div className="sidebar-note"><span className="small-ring" />会议内容保存在本机</div></>}
    <div className="sidebar-bottom"><button onClick={appearance} title="外观配色"><Palette size={17} />{!collapsed && <span>外观配色</span>}</button><button onClick={agent} title="Agent 接入"><Terminal size={17} />{!collapsed && <><span>Agent 接入</span><ArrowUpRight size={13} /></>}</button><button onClick={settings} title="连接设置"><Settings2 size={17} />{!collapsed && <span>连接设置</span>}</button><button onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开侧栏' : '收起侧栏'}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}{!collapsed && <span>收起侧栏</span>}</button></div>
  </aside>;
}

function Welcome({ create, importRecording, settings, agent }) {
  return <main id="meeting-main" tabIndex={-1} className="welcome"><div className="welcome-heading"><span className="eyebrow"><span className="small-ring" />为共同思考留出空间</span><h1>让每次讨论<br />都有进展<span>。</span></h1><p>发现藏在细节里的不同理解，把前提和取舍说清。<br />让每个人知道，当前的决定建立在什么基础上。</p><div className="welcome-actions"><Button className="primary welcome-create" onClick={create}><Plus size={17} />创建第一场会议<ArrowUpRight size={16} /></Button><Button className="welcome-import" onClick={importRecording}><Upload size={16} />导入已有录音</Button></div></div>
    <div className="welcome-preview" aria-label="会议工作方式"><div className="preview-heading"><span className="preview-dot" /><span>从原话，到共同的理解</span><AudioLines size={17} /></div><div className="preview-flow"><div><span className="preview-number">01</span><AudioLines size={24} strokeWidth={1.4} /><h3>留住原话</h3><p>实时转录与录音回听，<br />让依据始终可见。</p></div><div><span className="preview-number">02</span><GitBranch size={24} strokeWidth={1.4} /><h3>找到卡点</h3><p>澄清概念、前提与取舍，<br />找到值得共同回答的问题。</p></div><div><span className="preview-number">03</span><Sparkles size={24} strokeWidth={1.4} /><h3>说清再往前</h3><p>记下工作口径与待验证前提，<br />把澄清带进下一步决定。</p></div></div><div className="preview-footer"><span><CheckCheck size={13} />工作口径</span><span><Target size={13} />待验证前提</span><span><CircleHelp size={13} />保留分歧</span><span className="preview-footer-caption">保留依据，也保留分歧</span></div></div>
    <div className="welcome-footer"><button onClick={settings}><Settings2 size={14} />配置语音识别与 AI</button><span>·</span><button onClick={agent}><Terminal size={14} />连接 Codex 等 Agent</button></div>
  </main>;
}

export default function App() {
  const [savedLayout] = useState(readLayout);
  const [meetings, setMeetings] = useState([]);
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState(initialMeetingId);
  const [meeting, setMeeting] = useState(null);
  const [transcript, setTranscript] = useState({ lines: [], total: 0, loaded: null });
  const { lines, total } = transcript;
  const [windowSize, setWindowSize] = useState(100);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [discussionView, setDiscussionView] = useState('clarification');
  const [topicsOpened, setTopicsOpened] = useState(false);
  const [selectedClarification, setSelectedClarification] = useState(null);
  const [resolutionId, setResolutionId] = useState(null);
  const [focusedLine, setFocusedLine] = useState(null);
  const [locating, setLocating] = useState(false);
  const [modal, setModal] = useState(null);
  const [settings, setSettings] = useState(null);
  const [listError, setListError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState(null);
  const [liveCapture, setLiveCapture] = useState(null);
  const [partial, setPartial] = useState(null);
  const [command, setCommand] = useState(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [audioSource, setAudioSource] = useState('microphone');
  const [presentation, setPresentation] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(savedLayout.sidebarCollapsed === true);
  const [sidebarWidth, setSidebarWidth] = useState(() => layoutSize(savedLayout.sidebarWidth, 248, 205, 350));
  const [activeTool, setActiveTool] = useState(null);
  const [askScope, setAskScope] = useState('');
  const [submitting, setSubmitting] = useState('');
  const [discussionRequest, setDiscussionRequest] = useState(null);
  const discussionSubmission = useRef(null);
  const [retryingImport, setRetryingImport] = useState(false);
  const selectedRef = useRef(selectedId);
  const captureRef = useRef(null);
  const activeRefresh = useRef(null), refreshVersion = useRef(0);
  const listVersion = useRef(0), archivedRef = useRef(archived), windowSizeRef = useRef(windowSize);
  const transcriptRef = useRef(transcript);
  const evidenceRequest = useRef(0);
  const questionInput = useRef(null);
  const deepLinkRead = useRef(false);
  const previousStatus = useRef(null);
  selectedRef.current = selectedId;
  archivedRef.current = archived;
  windowSizeRef.current = windowSize;
  // Cache only committed data: a superseded transition must not mark unseen lines as loaded.
  useLayoutEffect(() => { transcriptRef.current = transcript; }, [transcript]);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem('meeting-workbench:layout', JSON.stringify({ sidebarCollapsed, sidebarWidth })); } catch { /* Private browsing and storage limits must not interrupt interaction. */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed, sidebarWidth]);
  useEffect(() => {
    const exitFocus = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || activeTool || document.querySelector('dialog[open]')) return;
      const menu = document.querySelector('.discussion-options[open]');
      if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.preventDefault(); }
      else setPresentation(false);
    };
    window.addEventListener('keydown', exitFocus);
    return () => window.removeEventListener('keydown', exitFocus);
  }, [activeTool]);
  useEffect(() => {
    const dismissMenu = event => {
      const menu = document.querySelector('.discussion-options[open]');
      if (menu && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener('pointerdown', dismissMenu);
    return () => document.removeEventListener('pointerdown', dismissMenu);
  }, []);

  const notify = useCallback((message, kind = 'error') => setToast({ message, kind, key: Date.now() }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 10000 : 5000); return () => clearTimeout(timer); }, [toast]);
  const loadList = useCallback(async (showArchived = archivedRef.current) => {
    const version = ++listVersion.current;
    const current = () => version === listVersion.current && showArchived === archivedRef.current;
    try {
      const result = await api(`/api/meetings${showArchived ? '?archived=1' : ''}`);
      if (!current()) return;
      startTransition(() => setMeetings(previous => !current() || JSON.stringify(previous) === JSON.stringify(result.meetings) ? previous : result.meetings));
      setListError(previous => current() ? '' : previous);
      setSelectedId(previous => current() ? previous || result.meetings[0]?.id || null : previous);
    } catch (error) { if (current()) setListError(error.message); }
  }, []);
  useEffect(() => { loadList(archived); const timer = setInterval(() => loadList(archived), 4000); return () => { clearInterval(timer); listVersion.current++; }; }, [archived, loadList]);
  useEffect(() => { api('/api/settings').then(setSettings).catch(() => {}); }, []);

  const refresh = useCallback(async () => {
    if (!selectedId || selectedRef.current !== selectedId || windowSizeRef.current !== windowSize) return;
    const fetchKey = `${selectedId}:${windowSize}`;
    if (activeRefresh.current?.key === fetchKey) return;
    const request = { key: fetchKey, version: ++refreshVersion.current };
    activeRefresh.current = request;
    const current = () => refreshVersion.current === request.version && selectedRef.current === selectedId && windowSizeRef.current === windowSize;
    try {
      const next = await api(meetingPath(selectedId));
      if (!current()) return;
      startTransition(() => setMeeting(previous => !current() || (previous && JSON.stringify(previous) === JSON.stringify(next)) ? previous : next)); setConnectionError('');
      const loaded = transcriptRef.current.loaded;
      if (loaded?.id === selectedId && loaded.revision === next.transcriptRevision && loaded.windowSize === windowSize) return;
      const head = await api(`${meetingPath(selectedId, '/transcript')}?limit=1`);
      if (!current()) return;
      const count = head.total || 0;
      const from = Math.max(0, count - windowSize);
      const pages = [];
      for (let cursor = from; cursor < count; cursor += 100) pages.push(api(`${meetingPath(selectedId, '/transcript')}?cursor=${cursor}&limit=${Math.min(100, count - cursor)}`));
      const results = await Promise.all(pages);
      if (!current()) return;
      const refreshedLines = results.flatMap(page => page.lines);
      startTransition(() => { setTranscript(previous => current() ? { lines: refreshedLines, total: count, loaded: { id: selectedId, revision: next.transcriptRevision, windowSize } } : previous); setFocusedLine(previous => { if (!previous || !current()) return previous; const updated = refreshedLines.find(line => line.id === previous.id); return updated ? { ...updated, play: previous.play } : previous; }); }); setLoadingEarlier(false);
    } catch (error) { if (current()) { setConnectionError(error.message); setLoadingEarlier(false); } }
    finally { if (activeRefresh.current === request) activeRefresh.current = null; }
  }, [selectedId, windowSize]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 2000); return () => { clearInterval(timer); refreshVersion.current++; activeRefresh.current = null; }; }, [refresh]);
  useEffect(() => {
    setActiveTool(null); setLocating(false); setMeeting(null); setTranscript({ lines: [], total: 0, loaded: null }); setWindowSize(100); setSelectedTopic(null); setDiscussionView('clarification'); setTopicsOpened(false); setSelectedClarification(null); setResolutionId(null); setFocusedLine(null); setPartial(null); setLiveCapture(null); setCommand(null); setAskScope(''); setConnectionError(''); setDiscussionRequest(null); setSubmitting(''); discussionSubmission.current = null; previousStatus.current = null;
    if (!selectedId) return;
    try { localStorage.setItem('meeting-workbench:selected', selectedId); } catch { /* Selection also remains in the URL. */ }
    const url = new URL(location.href); url.searchParams.set('meeting', selectedId); history.replaceState(null, '', url);
  }, [selectedId]);
  const captureMeetingId = meeting?.id === selectedId && meeting.source !== 'recording_import' ? meeting.id : null;
  useEffect(() => {
    if (!captureMeetingId) return;
    const client = new CaptureClient({ meetingId: captureMeetingId,
      onState: value => { if (selectedRef.current === captureMeetingId) { setLiveCapture(value); if (value.state !== 'recording') setPartial(null); } },
      onPartial: value => { if (selectedRef.current === captureMeetingId) setPartial(value); },
      onError: error => { if (selectedRef.current === captureMeetingId) notify(typeof error === 'string' ? error : error.message); },
      onCommand: value => { if (selectedRef.current === captureMeetingId) { setCommand(value); if (value.action === 'end' && value.status === 'done') setModal('minutes'); } },
    });
    captureRef.current = client; client.connect();
    return () => { client.disconnect(); if (captureRef.current === client) captureRef.current = null; };
  }, [captureMeetingId, notify]);
  useEffect(() => { if (!meeting) return; if (previousStatus.current && previousStatus.current !== 'ended' && meeting.status === 'ended') setModal('minutes'); previousStatus.current = meeting.status; }, [meeting?.status]);
  const capture = liveCapture || meeting?.capture || { connected: false, state: 'idle' };
  const locked = ['recording', 'paused'].includes(capture.state) || commandBusy || ['pending', 'running', 'needs_user_action'].includes(command?.status);
  useEffect(() => {
    if (!locked) return;
    const handler = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [locked]);
  const mutate = useCallback(async (suffix, method, body) => { const result = await api(meetingPath(selectedId, suffix), { method, body }); await refresh(); loadList(); return result; }, [selectedId, refresh, loadList]);
  async function createMeeting(body) {
    const value = await api('/api/meetings', { method: 'POST', body }); setArchived(false); setSelectedId(value.id); loadList(false);
  }
  async function archiveMeeting(id, value) {
    try { await api(meetingPath(id), { method: 'PATCH', body: { archived: value } }); if (id === selectedId) { const next = meetings.find(item => item.id !== id); setSelectedId(next?.id || null); if (!next) localStorage.removeItem('meeting-workbench:selected'); } await loadList(); notify(value ? '会议已归档，可以从归档列表恢复。' : '会议已恢复。', 'success'); }
    catch (error) { notify(error.message); }
  }
  const submitJob = useCallback(async (type, input = {}) => {
    const job = await api(meetingPath(selectedId, '/jobs'), { method: 'POST', body: { type, ...input } });
    if (selectedRef.current === selectedId) {
      // A pre-submission poll must not replace the newly accepted task with an old snapshot.
      refreshVersion.current++; activeRefresh.current = null;
      setMeeting(previous => previous?.id === selectedId ? { ...previous, jobs: [job, ...(previous.jobs || []).filter(item => item.id !== job.id)] } : previous);
      void refresh();
    }
    return job;
  }, [selectedId, refresh]);
  async function triggerJob(type, input = {}) {
    if (discussionSubmission.current) return;
    const request = { meetingId: selectedId, type, input, status: 'submitting' };
    discussionSubmission.current = request; setSubmitting(type); setDiscussionRequest(request);
    try { await submitJob(type, input); if (selectedRef.current === selectedId && discussionSubmission.current === request) setDiscussionRequest(null); }
    catch (error) { if (selectedRef.current === selectedId && discussionSubmission.current === request) { setDiscussionRequest({ ...request, status: 'error', error: error.message }); notify(error.message); } }
    finally { if (discussionSubmission.current === request) { discussionSubmission.current = null; setSubmitting(''); } }
  }
  async function retryImport() { setRetryingImport(true); try { await mutate('/import/retry', 'POST', {}); } catch (error) { notify(error.message); } finally { setRetryingImport(false); } }
  async function requestCommand(action) {
    setCommandBusy(true);
    try { const value = await captureRef.current.request(action); setCommand(value); if (value.status === 'error') notify(value.error || '录音操作失败'); await refresh(); }
    catch (error) { notify(error.message); } finally { setCommandBusy(false); }
  }
  const focusEvidence = useCallback(async id => {
    const request = ++evidenceRequest.current;
    const meetingId = selectedId;
    const current = () => request === evidenceRequest.current && selectedRef.current === meetingId;
    setActiveTool('transcript'); setFocusedLine(null);
    const found = lines.find(line => line.id === id);
    if (found) { setFocusedLine(found); setLocating(false); return; }
    setLocating(true);
    try {
      let cursor = 0;
      while (cursor !== null) {
        const page = await api(`${meetingPath(meetingId, '/transcript')}?cursor=${cursor}&limit=100`);
        if (!current()) return;
        const source = page.lines.find(line => line.id === id);
        if (source) { setFocusedLine(source); return; }
        if (page.nextCursor == null || page.nextCursor <= cursor) break;
        cursor = page.nextCursor;
      }
      if (current()) notify('这条引用的原文暂时无法定位，请更新整理后重试。');
    } catch (error) { if (current()) notify(error.message); } finally { if (current()) setLocating(false); }
  }, [selectedId, lines, notify]);
  useEffect(() => { if (meeting && !deepLinkRead.current) { deepLinkRead.current = true; const id = new URLSearchParams(location.search).get('transcript'); if (id) focusEvidence(id); } }, [meeting, focusEvidence]);

  const jobs = meeting?.jobs || [];
  const importJob = [...jobs].filter(job => job.type === 'import').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const importing = importJob && ['queued', 'running'].includes(importJob.status);
  const activeJobs = jobs.filter(job => job.type !== 'import' && ['queued', 'running'].includes(job.status));
  const organizeJob = activeJobs.find(job => ['organize', 'minutes'].includes(job.type));
  const followupJob = activeJobs.find(job => job.type === 'followup');
  const discussionJob = latestDiscussionJob(jobs);
  const jobGroup = job => ['organize', 'minutes'].includes(job.type) ? 'organization' : job.type;
  const latestJobByType = [...jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).filter((job, index, sorted) => sorted.findIndex(item => jobGroup(item) === jobGroup(job)) === index);
  const latestOrganization = latestJobByType.find(job => jobGroup(job) === 'organization');
  const latestError = latestJobByType.find(job => job.status === 'error' && !(job.type === 'followup' && latestOrganization && String(latestOrganization.createdAt).localeCompare(String(job.createdAt)) >= 0));
  const progressCount = meeting?.followups?.filter(item => !item.mergedInto && ['active', 'recorded', 'resolved'].includes(item.status) && item.resolution).length || 0;
  const duration = (meeting?.recordings || []).reduce((sum, recording) => sum + (recording.sampleCount || 0) / 16, 0);
  const pendingAuthorization = command?.status === 'needs_user_action' ? command : null;
  const activeCommand = ['pending', 'running'].includes(command?.status);
  const showTopic = useCallback(id => { setSelectedTopic(id); setTopicsOpened(true); setDiscussionView('topics'); }, []);
  const askTopic = useCallback(id => { setAskScope(id); setActiveTool('questions'); requestAnimationFrame(() => questionInput.current?.focus()); }, []);
  const closeTool = useCallback(() => setActiveTool(null), []);
  function toggleTool(tool) { setActiveTool(current => current === tool ? null : tool); }
  function closeDiscussionMenu(event) { if (!event.target.closest('button')) return; const menu = event.currentTarget.closest('details'); if (menu) { menu.open = false; if (!document.querySelector('dialog[open]')) menu.querySelector('summary')?.focus({ preventScroll: true }); } }
  const clearTranscriptFocus = useCallback(() => setFocusedLine(null), []);
  const loadEarlier = useCallback(() => { setLoadingEarlier(true); setWindowSize(size => size + 100); }, []);
  function onDiscussionKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'clarification' : event.key === 'End' ? 'topics' : discussionView === 'clarification' ? 'topics' : 'clarification';
    if (next === 'topics') setTopicsOpened(true);
    setDiscussionView(next);
    document.getElementById(next === 'topics' ? 'topics-tab' : 'clarification-tab')?.focus();
  }


  return <div className={`app focused-workbench ${presentation ? 'presentation-mode' : ''}`}><a className="skip-link" href="#meeting-main">跳到会议内容</a>
    {!presentation && <><Sidebar meetings={meetings} archived={archived} setArchived={setArchived} selectedId={selectedId} select={setSelectedId} create={() => setModal('create')} importRecording={() => setModal('import')} settings={() => setModal('settings')} appearance={() => setModal('theme')} agent={() => setModal('agent')} locked={locked} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} width={sidebarWidth} error={listError} />{!sidebarCollapsed && <ResizeHandle label="调整侧栏宽度" value={sidebarWidth} onChange={setSidebarWidth} min={205} max={350} />}</>}
    {!selectedId ? <Welcome create={() => setModal('create')} importRecording={() => setModal('import')} settings={() => setModal('settings')} agent={() => setModal('agent')} /> : !meeting ? <main id="meeting-main" tabIndex={-1} className="meeting-loading">{connectionError ? <EmptyState icon={CircleAlert} title="暂时无法加载会议" action={<Button onClick={refresh}><RefreshCw size={14} />重新连接</Button>}>{connectionError}</EmptyState> : <><LoaderCircle size={24} className="spin" /><p>正在打开会议…</p></>}</main> : <main id="meeting-main" tabIndex={-1} className="main-workspace">
      <header className="meeting-header">
        <div className="meeting-heading">
          <div className="meeting-overline"><span>{formatDate(meeting.createdAt)}</span><span>{statusLabels[meeting.status]}{meeting.archived ? ' · 已归档' : ''}</span></div>
          <div className="meeting-title-row"><h1>{meeting.title}</h1></div>
        </div>
        <div className="meeting-header-actions">
          {meeting.status !== 'ended' && <>
            {['recording', 'paused', 'interrupted'].includes(capture.state) && <span className={`header-capture-state ${capture.state}`} role="status"><span className={capture.state === 'recording' ? 'live-dot' : 'status-dot'} />{captureLabels[capture.state]}</span>}
            {capture.state === 'recording' ? <Button className="recording-pause small" onClick={() => requestCommand('pause')} busy={commandBusy} disabled={activeCommand}><Pause size={14} />暂停</Button> : <Button className="primary small" onClick={() => requestCommand(capture.state === 'paused' ? 'resume' : 'start')} busy={commandBusy} disabled={activeCommand || Boolean(pendingAuthorization) || !capture.connected}>{capture.state === 'paused' ? <Play size={14} /> : <Mic size={14} />}{capture.state === 'paused' ? '继续录音' : capture.state === 'interrupted' ? '重新录音' : '开始录音'}</Button>}
            <Button className="end-meeting text-button small" disabled={commandBusy || activeCommand || Boolean(pendingAuthorization)} onClick={() => requestCommand('end')}>结束会议</Button>
          </>}
          {presentation && <IconButton title="退出展示模式" onClick={() => setPresentation(false)}><Minimize2 size={17} /></IconButton>}
          <details className="discussion-options meeting-options">
            <summary aria-label="会议操作" title="会议操作"><MoreHorizontal size={20} /></summary>
            <div className="discussion-options-menu" onClick={closeDiscussionMenu}>
              <div className="meeting-menu-group">
                <button onClick={() => setModal('minutes')}>会议纪要</button>
                <button onClick={() => setModal('edit')}>编辑会议名称和目标</button>
                <button onClick={() => setPresentation(!presentation)}>{presentation ? '退出展示模式' : '进入展示模式'}</button>
                {['recording', 'paused'].includes(capture.state) && <button disabled={commandBusy || activeCommand} onClick={() => requestCommand('stop')}>停止录音，保留会议</button>}
              </div>
              <div className="meeting-menu-group">
                <button disabled={Boolean(organizeJob) || submitting === 'organize' || !meeting.transcriptRevision || importing} onClick={() => triggerJob('organize', { force: true })}>重新分析全部原文</button>
                <button disabled={Boolean(followupJob) || submitting === 'followup' || !meeting.transcriptRevision || importing} onClick={() => triggerJob('followup')}>再找一个问题</button>
                <button onClick={() => mutate('', 'PATCH', { autoOrganize: !meeting.autoOrganize }).catch(error => notify(error.message))}>{meeting.autoOrganize ? '暂停自动整理' : '恢复自动整理'}</button>
                <button disabled={Boolean(organizeJob) || submitting === 'organize' || !meeting.transcriptRevision || importing} onClick={() => triggerJob('organize')}>仅更新新增原文</button>
                <button onClick={() => setModal('processing')}>处理记录</button>
              </div>
              <div className="meeting-menu-group"><button onClick={() => setModal('settings')}>连接设置</button><button onClick={() => setModal('theme')}>外观配色</button></div>
              <div className="meeting-menu-group"><button disabled={locked} title={locked ? '先停止当前录音，再归档会议' : undefined} onClick={() => archiveMeeting(meeting.id, !meeting.archived)}>{meeting.archived ? '恢复会议' : '归档会议'}</button></div>
              <p className="meeting-menu-status">{organizeJob ? '正在整理…' : meeting.processedRevision ? `已整理至 ${formatTime(meeting.processedThroughMs)}` : meeting.transcriptRevision ? '等待分析' : '等待原文'} · {meeting.autoOrganize ? '自动整理已开启' : '自动整理已暂停'}</p>
              {meeting.goal && <p className="meeting-menu-goal">讨论目标：{meeting.goal}</p>}
            </div>
          </details>
        </div>
      </header>
      {importJob && (importing || importJob.status === 'error' || importJob.result?.analysisState === 'no_transcript' || !settings?.llm?.configured) && <ImportStatus job={importJob} retrying={retryingImport} onRetry={retryImport} onSettings={() => setModal('settings')} llmConfigured={settings?.llm?.configured} />}
      {pendingAuthorization && <div className="authorization-banner"><Mic size={18} /><div><strong>{pendingAuthorization.action === 'resume' ? '继续录音需要音频授权' : '已准备好，请选择音频来源'}</strong><p>音频授权由主持人在当前浏览器完成。{audioSource === 'meeting' ? '选择共享来源时，同时勾选共享音频。' : '收到音频并保存后才会显示正在录音。'}</p></div><select aria-label="音频来源" value={audioSource} onChange={event => setAudioSource(event.target.value)}><option value="microphone">麦克风</option><option value="meeting">麦克风 + 会议声音</option></select><Button className="primary small" busy={commandBusy} onClick={async () => { setCommandBusy(true); try { await captureRef.current.startFromGesture(pendingAuthorization.id, audioSource); await refresh(); } catch (error) { notify(error.message); } finally { setCommandBusy(false); } }}>授权并{pendingAuthorization.action === 'resume' ? '继续' : '开始'}录音</Button><Button className="small" disabled={commandBusy} onClick={() => requestCommand('stop')}>取消</Button></div>}
      {activeCommand && <div className="command-progress"><LoaderCircle size={13} className="spin" />{['pause', 'stop', 'end'].includes(command.action) ? '正在保存尾段音频并等待最后一句转录…' : '正在等待实际音频采集…'}</div>}
      {connectionError && <div className="connection-banner" role="alert"><CircleAlert size={15} />数据连接中断：{connectionError}<button onClick={refresh}>重试</button></div>}
      {meeting.source !== 'recording_import' && capture.error && <div className="capture-error" role="alert"><CircleAlert size={14} />{capture.error}</div>}
      {meeting.source !== 'recording_import' && capture.asrError && <div className="asr-error" role="status"><CircleAlert size={14} /><span>转录：{capture.asrError}{capture.state === 'recording' && ' · 录音仍在保存'}</span><button onClick={() => setModal('settings')}>连接设置</button></div>}
      <section className="discussion-stage" aria-label="当前讨论">
        <div className="panel-body">
          <div className="discussion-toolbar"><div className="discussion-tabs" role="tablist" aria-label="讨论工作区">
            <button id="clarification-tab" role="tab" aria-selected={discussionView === 'clarification'} aria-controls="clarification-view" tabIndex={discussionView === 'clarification' ? 0 : -1} onKeyDown={onDiscussionKey} onClick={() => setDiscussionView('clarification')}>澄清焦点</button>
            <button id="topics-tab" role="tab" aria-selected={discussionView === 'topics'} aria-controls="topics-view" tabIndex={discussionView === 'topics' ? 0 : -1} onKeyDown={onDiscussionKey} onClick={() => { setTopicsOpened(true); setDiscussionView('topics'); }}>讨论脉络</button>
          </div><DiscussionStatus key={meeting.id} job={discussionJob} request={discussionRequest} onRetry={triggerJob} onSettings={() => setModal('settings')} onHistory={() => setModal('processing')} /></div>
          <div id="clarification-view" className="discussion-view" role="tabpanel" aria-labelledby="clarification-tab" hidden={discussionView !== 'clarification'}><ClarificationPanel key={meeting.id} meeting={meeting} selected={selectedClarification} setSelected={setSelectedClarification} onEvidence={focusEvidence} onTopic={showTopic} mutate={mutate} job={followupJob} onRequestQuestion={() => triggerJob('followup')} questionRequestBusy={Boolean(followupJob) || submitting === 'followup'} analysisStatus={discussionRequest || discussionJob} pauseFollowing={Boolean(resolutionId)} /></div>
          <div id="topics-view" className="discussion-view" role="tabpanel" aria-labelledby="topics-tab" hidden={discussionView !== 'topics'}>{topicsOpened && <PanelErrorBoundary key={meeting.id} fallback={<EmptyState icon={CircleAlert} title="讨论脉络暂时无法加载" action={<><Button disabled={locked} onClick={() => window.location.reload()}>刷新页面重试</Button><Button onClick={() => setDiscussionView('clarification')}>返回澄清焦点</Button></>}>显示组件未能加载，会议数据仍保存在本机。{locked ? '请先保存或停止录音，再刷新页面。' : '刷新页面后重试；未发送的输入请先保留。'}</EmptyState>}><Suspense fallback={<div className="panel-loading" role="status"><LoaderCircle size={18} className="spin" />正在打开讨论脉络…</div>}><TopicPanel key={meeting.id} meeting={meeting} selected={selectedTopic} setSelected={setSelectedTopic} onEvidence={focusEvidence} mutate={mutate} onAskTopic={askTopic} /></Suspense></PanelErrorBoundary>}</div>
        </div>
      </section>
      <footer className="meeting-tool-dock" aria-label="会议工具">
        <button className={`meeting-tool-launcher recording-launcher ${capture.state}`} aria-label="录音与原文" aria-expanded={activeTool === 'transcript'} aria-controls="transcript-tool" aria-haspopup="dialog" onClick={() => toggleTool('transcript')}>
          <span className="tool-label">录音与原文</span>{meeting.source !== 'recording_import' && ['recording', 'paused', 'interrupted'].includes(capture.state) && <span className={`tool-recording-state ${capture.state === 'recording' ? 'is-recording' : ''}`}><span className={capture.state === 'recording' ? 'live-dot' : 'status-dot'} />{meeting.source === 'recording_import' ? (importing ? '导入中' : importJob?.status === 'error' ? '导入未完成' : '已导入') : captureLabels[capture.state] || capture.state}</span>}<time>{formatTime(duration)}</time>
        </button>
        <div className="meeting-tool-dock-actions">
          {latestError && latestError.id !== discussionJob?.id && <button className="dock-job-error" onClick={() => setModal('processing')} title={`${jobLabels[latestError.type]}失败：${latestError.error}`}><CircleAlert size={13} /><span>{jobLabels[latestError.type]}失败</span></button>}
          {!settings?.llm?.configured && <button className="dock-configure" onClick={() => setModal('settings')}><Settings2 size={13} />配置 AI</button>}
          <button className="meeting-tool-launcher" aria-expanded={activeTool === 'progress'} aria-controls="progress-tool" aria-haspopup="dialog" onClick={() => toggleTool('progress')}><span className="tool-label">讨论进展</span>{progressCount > 0 && <small>{progressCount}</small>}</button>
          <button className="meeting-tool-launcher" aria-expanded={activeTool === 'questions'} aria-controls="questions-tool" aria-haspopup="dialog" onClick={() => toggleTool('questions')}>{activeJobs.some(job => job.type === 'answer') && <LoaderCircle size={15} className="spin" />}<span className="tool-label">问 AI</span></button>
        </div>
      </footer>
      <MeetingToolWindow id="transcript-tool" title="录音与原文" active={activeTool === 'transcript'} onClose={closeTool}>
        {meeting.source !== 'recording_import' && <div className="transcript-service-status"><span>{capture.connected ? '本地保存已连接' : '本地保存未连接'}</span><span>{asrLabels[capture.asrState] || (settings?.asr?.configured ? '转录待启动' : '转录未配置')}</span>{!settings?.asr?.configured && <button onClick={() => setModal('settings')}>配置转录</button>}</div>}
        <TranscriptPanel key={meeting.id} visible={activeTool === 'transcript'} meeting={meeting} lines={lines} total={total} partial={partial} focusedLine={focusedLine} onFocusLine={setFocusedLine} clearFocus={clearTranscriptFocus} locating={locating} mutate={mutate} onLoadEarlier={loadEarlier} loadingEarlier={loadingEarlier} />
      </MeetingToolWindow>
      <MeetingToolWindow id="progress-tool" title="讨论进展" active={activeTool === 'progress'} onClose={closeTool}><ProgressPanel meeting={meeting} onEvidence={focusEvidence} onResolve={setResolutionId} /></MeetingToolWindow>
      <MeetingToolWindow id="questions-tool" title="问 AI" active={activeTool === 'questions'} onClose={closeTool}><QuestionPanel key={meeting.id} meeting={meeting} onEvidence={focusEvidence} askScope={askScope} setAskScope={setAskScope} inputRef={questionInput} submitJob={submitJob} /></MeetingToolWindow>
    </main>}
    {toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.kind === 'error' ? <CircleAlert size={17} /> : <Check size={17} />}<p>{toast.message}</p><IconButton title="关闭提示" onClick={() => setToast(null)}><X size={14} /></IconButton></div>}
    {modal === 'import' && <ImportDialog settings={settings} onClose={() => setModal(null)} onImported={({ meeting: imported }) => { setArchived(false); setSelectedId(imported.id); loadList(false); }} />}
    {modal === 'processing' && meeting && <ProcessingDialog meeting={meeting} onClose={() => setModal(null)} />}
    {modal === 'create' && <MeetingDialog onClose={() => setModal(null)} onSave={createMeeting} />}
    {modal === 'edit' && meeting && <MeetingDialog meeting={meeting} onClose={() => setModal(null)} onSave={body => mutate('', 'PATCH', body)} />}
    {modal === 'theme' && <ThemeDialog onClose={() => setModal(null)} />}
    {modal === 'settings' && <SettingsDialog onClose={() => setModal(null)} onSaved={setSettings} />}
    {modal === 'minutes' && meeting && <MinutesDialog meeting={meeting} onClose={() => setModal(null)} mutate={mutate} submitJob={submitJob} onEvidence={id => { setModal(null); focusEvidence(id); }} />}
    {resolutionId && meeting?.followups?.some(item => item.id === resolutionId) && <ResolutionDialog key={`${meeting.id}:${resolutionId}`} item={meeting.followups.find(item => item.id === resolutionId)} meeting={meeting} lines={lines} mutate={mutate} onClose={() => setResolutionId(null)} />}
    {modal === 'agent' && <AgentDialog onClose={() => setModal(null)} />}
  </div>;
}
