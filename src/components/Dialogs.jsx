import { meetingScenarios, meetingScenario, awaitingSpeakers } from '../../shared/meeting-scenarios.js';
import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Check, Copy, Download, FileAudio, FileText, Headphones, KeyRound, Mic, Pencil, Save, Settings2, Sparkles, Terminal, Upload } from 'lucide-react';
import { api, downloadText, formatDate, uploadRecording } from '../lib/api.js';
import { Button, EmptyState, Evidence, FormError, Modal, useFormAction } from './ui.jsx';
import { MeetingMarkdown } from './AiPanels.jsx';
import { ResolutionSummary } from './ClarificationPanel.jsx';
import { minutesDocumentMarkdown } from '../../shared/minutes-format.js';
import { speakerReviewProgress } from '../../shared/discussion-status.js';

function ScenarioField({ value, onChange, disabled }) {
  return <label>会议场景<select value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>{Object.entries(meetingScenarios).map(([key, scene]) => <option key={key} value={key}>{scene.label}</option>)}</select><span className="form-hint">{meetingScenarios[value].hint}</span></label>;
}

export function MeetingDialog({ meeting, onClose, onSave }) {
  const [title, setTitle] = useState(meeting?.title || '');
  const [goal, setGoal] = useState(meeting?.goal || '');
  const [scenario, setScenario] = useState(meeting ? meetingScenario(meeting) : 'regular');
  const { submit, busy, error } = useFormAction(async () => { await onSave({ title: title.trim(), goal: goal.trim(), scenario }); onClose(); });
  return <Modal title={meeting ? '编辑会议' : '开启一场有进展的讨论'} subtitle={meeting ? '讨论目标帮助 AI 理解方向，不作为会议事实。' : '写下这次要说清的事情，让每个人带着同一个问题开始。'} onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit} aria-busy={busy}><ScenarioField value={scenario} onChange={setScenario} disabled={busy} /><label>会议名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="例如：产品试点方案讨论" required disabled={busy} /></label><label>讨论目标 <span className="optional">可选</span><textarea value={goal} onChange={event => setGoal(event.target.value)} rows={4} maxLength={6000} placeholder="这次会议结束时，希望明确什么？" disabled={busy} /></label><div className="form-info"><Mic size={16} /><span>进入会议后选择音频来源并授权录音。</span></div><FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="primary" busy={busy} disabled={!title.trim()}>{meeting ? '保存修改' : '创建会议'}</Button></div></form>
  </Modal>;
}

export function ImportDialog({ onClose, onImported, settings }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [goal, setGoal] = useState('');
  const [scenario, setScenario] = useState('regular');
  const [progress, setProgress] = useState(0);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null), dragDepth = useRef(0);
  const fileId = useId(), fileHeadingId = useId(), fileHintId = useId(), fileErrorId = useId();
  const { submit, busy, error } = useFormAction(async () => {
    if (!file) throw new Error('请选择录音文件。');
    setProgress(0);
    const result = await uploadRecording({ file, title: title.trim(), goal: goal.trim(), scenario }, setProgress);
    onImported(result);
    onClose();
  });
  useEffect(() => {
    const preventFileNavigation = event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => { window.removeEventListener('dragover', preventFileNavigation); window.removeEventListener('drop', preventFileNavigation); };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const protectUpload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectUpload);
    return () => window.removeEventListener('beforeunload', protectUpload);
  }, [busy]);
  function chooseFiles(files) {
    if (busy || !files?.length) return;
    const suffix = file ? '当前已选录音保持不变。' : '';
    if (files.length !== 1) { setFileError(`每次只能导入一份录音。${suffix}`); return; }
    const next = files[0];
    if (next.size > 512 * 1024 * 1024) { setFileError(`文件超过 512 MiB，请先分成较小的录音。${suffix}`); return; }
    if (!next.size) { setFileError(`这个文件是空的，请重新选择录音。${suffix}`); return; }
    if (!/\.(wav|mp3|m4a|mp4|flac|ogg|oga|webm|mkv|mov|aac|aif|aiff|au|amr)$/i.test(next.name)) { setFileError(`暂不支持此格式，请选择 WAV、MP3、M4A 等录音文件。${suffix}`); return; }
    setFile(next); setFileError(''); setProgress(0);
    if (!titleEdited || !title) setTitle(next.name.replace(/\.[^.]+$/, '').slice(0, 160));
  }
  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const sizeLabel = file ? file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KiB` : `${(file.size / 1024 / 1024).toFixed(1)} MiB` : '';
  return <Modal title="导入录音创建会议" subtitle="导入并转录 → 匹配与确认说话人 → 分析并生成纪要。" onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit} aria-busy={busy}>
      <div className={`recording-file-field ${file ? 'has-file' : ''} ${dragging ? 'is-dragging' : ''} ${busy ? 'is-uploading' : ''}`} role="group" aria-labelledby={fileHeadingId}
        onDragEnter={event => { if (!isFileDrag(event)) return; event.preventDefault(); if (!busy) { dragDepth.current++; setDragging(true); } }}
        onDragOver={event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
        onDragLeave={event => { if (!isFileDrag(event)) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); chooseFiles(event.dataTransfer.files); }}>
        <div className="recording-file-summary" role="status" aria-live="polite"><div className="recording-file-icon"><FileAudio size={26} aria-hidden="true" /></div><div className="recording-file-copy"><strong id={fileHeadingId}>{dragging ? '松开以选择录音' : file ? file.name : '将录音拖到这里'}</strong><span className="recording-file-meta">{file ? `${file.name.split('.').pop().toUpperCase()} · ${sizeLabel}` : '也可以从本机选择文件'}</span></div></div>
        <div className="recording-file-actions"><Button type="button" onClick={() => fileInput.current?.click()} disabled={busy} aria-controls={fileId}>{file ? '更换录音' : '选择文件'}</Button><input ref={fileInput} id={fileId} className="recording-file-input" type="file" tabIndex={-1} aria-label="录音文件" aria-describedby={`${fileHintId}${fileError ? ` ${fileErrorId}` : ''}`} aria-invalid={Boolean(fileError)} accept=".wav,.mp3,.m4a,.mp4,.flac,.ogg,.oga,.webm,.mkv,.mov,.aac,.aif,.aiff,.au,.amr" onChange={event => { chooseFiles(event.target.files); event.target.value = ''; }} disabled={busy} /></div>
        <small id={fileHintId} className="recording-file-hint">支持 WAV、MP3、M4A、MP4、FLAC、OGG、WebM 等格式，最大 512 MiB。</small>
      </div>
      <FormError id={fileErrorId} error={fileError} />
      <ScenarioField value={scenario} onChange={setScenario} disabled={busy} />
      <label>会议名称<input value={title} onChange={event => { setTitle(event.target.value); setTitleEdited(true); }} maxLength={160} placeholder="默认使用录音文件名" disabled={busy} required /></label>
      <label>讨论目标 <span className="optional">可选</span><textarea value={goal} onChange={event => setGoal(event.target.value)} rows={3} maxLength={6000} placeholder="希望借助这次讨论说清什么？" disabled={busy} /></label>
      <div className="form-info"><Headphones size={16} /><span>原录音保存在本机，转录使用{settings?.fileAsr?.provider === 'openai' ? '已配置的 OpenAI 兼容服务' : '火山引擎'}。上传完成后可离开此页面，处理会继续。</span></div>
      {settings?.fileAsr && !settings.fileAsr.configured && <p className="form-hint import-hint">文件转录尚未配置。请在「连接设置」中{settings.fileAsr.provider === 'openai' ? '填写文件转录服务信息' : '填写火山语音凭证；使用文件识别 2.0 时，还需配置 TOS 临时存储'}。</p>}
      {!settings?.llm?.configured && <p className="form-hint import-hint">AI 尚未配置。配置 AI 后，确认说话人即可生成纪要。</p>}
      {busy && <div className="upload-progress" role="status"><div><span>{progress < 100 ? '正在上传录音' : '文件已发送，正在确认本地保存'}</span><strong>{progress}%</strong></div><progress max="100" value={progress} aria-label="录音上传进度" /><p>请保持当前页面打开，上传完成后会自动进入会议。</p></div>}
      <FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="primary" busy={busy} disabled={!file || !title.trim()}><Upload size={14} />{busy ? '正在导入' : '导入并转录'}</Button></div>
    </form>
  </Modal>;
}

const jobKinds = { organize: '讨论整理', followup: '澄清检查', answer: '会议问答', minutes: '会议纪要', import: '录音导入', refresh_speakers: 'AI 人物归属更新' };
const jobStatuses = { queued: '等待处理', running: '处理中', done: '已完成', error: '失败', cancelled: '已取消，结果未应用', stale: '来源已更新', superseded: '已由新任务替代' };

export function ProcessingDialog({ meeting, onClose }) {
  const retrospective = meeting.source === 'recording_import';
  const kinds = retrospective ? { ...jobKinds, organize: '会议复盘', followup: '复盘焦点整理' } : jobKinds;
  const jobs = [...(meeting.jobs || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return <Modal title="处理记录" subtitle="查看处理状态、使用的模型和思考强度，方便比较分析效果。" onClose={onClose}>
    <div className="processing-history">{jobs.length ? jobs.map(job => <article className="processing-record" key={job.id}><div className="processing-heading"><strong>{kinds[job.type] || job.type}</strong><span className={`processing-status ${job.status}`}>{jobStatuses[job.status] || job.status}</span><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time></div>{job.type !== 'import' && <dl><div><dt>模型</dt><dd>{job.model === null ? '未调用模型' : job.model || '未记录'}</dd></div><div><dt>思考强度</dt><dd>{job.reasoningEffort === 'low' ? '较低（优先响应速度）' : job.reasoningEffort === 'default' ? '模型默认' : job.reasoningEffort === null ? '未调用模型' : '未记录'}</dd></div>{job.input?.force && <div><dt>{retrospective ? '复盘范围' : '分析范围'}</dt><dd>全部原文，保留人工修正</dd></div>}</dl>}{speakerReviewProgress(job) && <p className="processing-note" role="status">{speakerReviewProgress(job)}</p>}{job.error && <p className="form-error">{job.error}</p>}{job.type === 'import' && job.result?.message && <p className="processing-note">{job.result.message}</p>}</article>) : <EmptyState compact icon={Sparkles} title="还没有处理记录">{retrospective ? '导入录音或发起 AI 复盘后，记录会保存在这里。' : '导入录音或发起 AI 分析后，记录会保存在这里。'}</EmptyState>}</div><div className="modal-footer"><Button className="primary" onClick={onClose}>完成</Button></div>
  </Modal>;
}

export function SettingsDialog({ onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [loadingError, setLoadingError] = useState('');
  const [draft, setDraft] = useState({ llm: { baseUrl: '', model: '', apiKey: '', reasoningEffort: '' }, asr: { apiKey: '', appKey: '', accessKey: '', resourceId: 'volc.seedasr.sauc.duration' }, fileAsr: { provider: 'volcengine', resourceId: 'volc.seedasr.auc', baseUrl: 'http://127.0.0.1:8000', model: 'Qwen3-ASR-1.7B-8bit', apiKey: '', language: 'zh' }, tos: { region: 'cn-beijing', bucket: '', accessKeyId: '', accessKeySecret: '' } });
  useEffect(() => { let mounted = true; api('/api/settings').then(value => { if (mounted) { setSettings(value); setDraft({ llm: { baseUrl: value.llm?.baseUrl || '', model: value.llm?.model || '', apiKey: '', reasoningEffort: value.llm?.reasoningEffort || '' }, asr: { apiKey: '', appKey: '', accessKey: '', resourceId: value.asr?.resourceId || 'volc.seedasr.sauc.duration' }, fileAsr: { provider: value.fileAsr?.provider ?? 'volcengine', resourceId: value.fileAsr?.resourceId ?? 'volc.seedasr.auc', baseUrl: value.fileAsr?.baseUrl ?? 'http://127.0.0.1:8000', model: value.fileAsr?.model ?? 'Qwen3-ASR-1.7B-8bit', apiKey: '', language: value.fileAsr?.language ?? 'zh' }, tos: { region: value.tos?.region || 'cn-beijing', bucket: value.tos?.bucket || '', accessKeyId: '', accessKeySecret: '' } }); } }).catch(error => { if (mounted) setLoadingError(error.message); }); return () => { mounted = false; }; }, []);
  const change = (group, key, value) => setDraft(previous => ({ ...previous, [group]: { ...previous[group], [key]: value } }));
  const fileProviderChanged = settings && (draft.fileAsr.provider !== (settings.fileAsr?.provider ?? 'volcengine') || draft.fileAsr.resourceId !== settings.fileAsr?.resourceId);
  const { submit, busy, error } = useFormAction(async () => { const value = await api('/api/settings', { method: 'PUT', body: draft }); onSaved(value); onClose(); });
  return <Modal title="连接设置" subtitle="语音识别与 AI 独立配置。密钥保存在本机，留空会保留现有密钥。" onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit} aria-busy={busy}><FormError error={loadingError} />
      <div className="settings-section"><h3><Sparkles size={16} />AI 模型<span className={`config-pill ${settings?.llm?.configured ? 'configured' : ''}`}>{settings?.llm?.configured ? '已配置' : '待配置'}</span></h3><p>默认使用 OpenCode Go 的 DeepSeek V4.1 Flash，也支持其他兼容 OpenAI Chat Completions 的服务。</p><label>服务地址<input disabled={busy} type="url" value={draft.llm.baseUrl} onChange={event => change('llm', 'baseUrl', event.target.value)} placeholder="https://opencode.ai/zen/go/v1" autoComplete="off" spellCheck={false} /></label><div className="form-row"><label>模型名称<input disabled={busy} value={draft.llm.model} onChange={event => change('llm', 'model', event.target.value)} placeholder="deepseek-v4.1-flash" autoComplete="off" spellCheck={false} /></label><label>API Key<input disabled={busy} type="password" value={draft.llm.apiKey} onChange={event => change('llm', 'apiKey', event.target.value)} placeholder={settings?.llm?.configured ? '已配置，留空保留' : '输入 API Key'} autoComplete="new-password" /></label></div><label>思考强度<select disabled={busy} value={draft.llm.reasoningEffort} onChange={event => change('llm', 'reasoningEffort', event.target.value)}><option value="">模型默认</option><option value="low">较低（优先响应速度）</option></select><span className="form-hint">仅在模型服务支持时选择；默认沿用服务设置。</span></label></div>
      <div className="settings-section"><h3><Headphones size={16} />实时语音识别<span className={`config-pill ${settings?.asr?.configured ? 'configured' : ''}`}>{settings?.asr?.configured ? '已配置' : '待配置'}</span></h3><p>默认使用豆包实时语音识别 2.0（火山引擎）。请开通对应服务并填写 API Key；尚未配置时仍可保存录音、补充原文。</p><label>API Key<input disabled={busy} type="password" value={draft.asr.apiKey} onChange={event => change('asr', 'apiKey', event.target.value)} placeholder={settings?.asr?.configured ? '已配置，留空保留' : '输入语音识别 API Key'} autoComplete="new-password" /></label><details className="legacy-asr-settings"><summary>使用 App Key + Access Key</summary><div className="form-row"><label>App Key<input disabled={busy} type="password" value={draft.asr.appKey} onChange={event => change('asr', 'appKey', event.target.value)} placeholder="留空保留现有密钥" autoComplete="new-password" /></label><label>Access Key<input disabled={busy} type="password" value={draft.asr.accessKey} onChange={event => change('asr', 'accessKey', event.target.value)} placeholder="留空保留现有密钥" autoComplete="new-password" /></label></div></details><label>Resource ID<input disabled={busy} value={draft.asr.resourceId} onChange={event => change('asr', 'resourceId', event.target.value)} placeholder="volc.seedasr.sauc.duration" autoComplete="off" spellCheck={false} /></label></div>
      <div className="settings-section"><h3><FileAudio size={16} />录音文件转录<span className={`config-pill ${!fileProviderChanged && settings?.fileAsr?.configured ? 'configured' : ''}`}>{fileProviderChanged ? '待保存' : settings?.fileAsr?.configured ? '已配置' : '待配置'}</span></h3>
        <label>文件转录服务<select disabled={busy} value={draft.fileAsr.provider} onChange={event => change('fileAsr', 'provider', event.target.value)}><option value="volcengine">火山引擎（默认）</option><option value="openai">OpenAI 兼容服务</option></select></label>
        {draft.fileAsr.provider === 'volcengine' ? <>
          <p>复用上方火山语音凭证。请先在同一账号开通所选录音文件识别服务。</p>
          <label>文件识别版本<select disabled={busy} value={draft.fileAsr.resourceId} onChange={event => change('fileAsr', 'resourceId', event.target.value)}><option value="volc.seedasr.auc">豆包录音文件识别 2.0（推荐）</option><option value="volc.bigasr.auc_turbo">1.0 极速版（已有权限的账号）</option><option value="volc.bigasr.auc">1.0 标准版（已有权限的账号）</option></select></label>
          {['volc.seedasr.auc', 'volc.bigasr.auc'].includes(draft.fileAsr.resourceId) && <>
            <p>本地录音会自动上传到私有 TOS 存储桶，供火山读取。下载链接有效期为 24 小时，转录完成后自动清理临时副本；本机录音保留。</p>
            <div className="form-row"><label>TOS 地域<input disabled={busy} value={draft.tos.region} onChange={event => change('tos', 'region', event.target.value)} placeholder="cn-beijing" autoComplete="off" spellCheck={false} /></label><label>TOS 存储桶名称<input disabled={busy} value={draft.tos.bucket} onChange={event => change('tos', 'bucket', event.target.value)} placeholder="conference-workbench-你的唯一后缀" autoComplete="off" spellCheck={false} /></label></div>
            <div className="form-row"><label>TOS AccessKey ID<input disabled={busy} type="password" value={draft.tos.accessKeyId} onChange={event => change('tos', 'accessKeyId', event.target.value)} placeholder={settings?.tos?.hasAccessKeyId ? '已保存，留空保留' : '输入存储 AccessKey ID'} autoComplete="new-password" /></label><label>TOS AccessKey Secret<input disabled={busy} type="password" value={draft.tos.accessKeySecret} onChange={event => change('tos', 'accessKeySecret', event.target.value)} placeholder={settings?.tos?.hasAccessKeySecret ? '已保存，留空保留' : '输入存储 AccessKey Secret'} autoComplete="new-password" /></label></div>
            <span className="form-hint">存储密钥与豆包语音 API Key 不同。存储桶需允许这组密钥上传、读取和删除临时音频；建议为临时目录设置 2 天后删除的生命周期规则。配置步骤见项目使用指南。</span>
          </>}
        </> : <><p>可连接本机 oMLX 或其他兼容 OpenAI 音频转录接口的服务。</p><label>文件转录服务地址<input disabled={busy} type="url" value={draft.fileAsr.baseUrl} onChange={event => change('fileAsr', 'baseUrl', event.target.value)} placeholder="http://127.0.0.1:8000" autoComplete="off" spellCheck={false} /></label><div className="form-row"><label>文件转录模型<input disabled={busy} value={draft.fileAsr.model} onChange={event => change('fileAsr', 'model', event.target.value)} placeholder="Qwen3-ASR-1.7B-8bit" autoComplete="off" spellCheck={false} /></label><label>文件转录 API Key<input disabled={busy} type="password" value={draft.fileAsr.apiKey} onChange={event => change('fileAsr', 'apiKey', event.target.value)} placeholder="本地服务无密钥时可留空" autoComplete="new-password" /></label></div><label>录音语言<input disabled={busy} value={draft.fileAsr.language} onChange={event => change('fileAsr', 'language', event.target.value)} placeholder="zh" autoComplete="off" spellCheck={false} /></label></>}
        <span className="form-hint">导入录音需要 ffmpeg，用于格式转换、分段和定位回听。「已配置」不代表服务已连通。</span>
      </div>
      <div className="form-info"><KeyRound size={15} /><span>音频发送至已配置的 ASR 服务，会议原文发送至已配置的 AI 服务。</span></div><FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="primary" busy={busy} disabled={!settings}>保存设置</Button></div>
    </form>
  </Modal>;
}

export function MinutesDialog({ meeting, onClose, mutate, submitJob, onEvidence }) {
  const [artifactType, setArtifactType] = useState('minutes');
  const artifact = (meeting.artifacts || []).find(item => item.type === artifactType);
  const artifactMarkdown = minutesDocumentMarkdown(artifact);
  const minutes = (meeting.artifacts || []).find(item => item.type === 'minutes');
  const updateDraft = (meeting.artifacts || []).find(item => item.type === 'minutes-draft');
  const otherArtifacts = (meeting.artifacts || []).filter(item => !['minutes', 'minutes-draft'].includes(item.type));
  const isDraft = /^minutes-draft(?:-\d+)?$/.test(artifactType);
  const isMinutes = artifactType === 'minutes' || isDraft;
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState(artifactMarkdown);
  const [title, setTitle] = useState(artifact?.title || `${meeting.title} · 会议纪要`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generating = meeting.jobs?.some(job => job.type === 'minutes' && ['queued', 'running'].includes(job.status));
  useEffect(() => { if (!editing) { setMarkdown(artifactMarkdown); setTitle(artifact?.title || `${meeting.title} · 会议纪要`); } }, [artifactMarkdown, artifact?.title, editing, meeting.title]);
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(''); try { const savedType = isDraft ? 'minutes' : artifactType; await mutate(`/artifacts/${encodeURIComponent(savedType)}`, 'PUT', { title, markdown, author: 'host', sourceRevision: artifact?.sourceRevision ?? meeting.transcriptRevision }); setEditing(false); setArtifactType(savedType); } catch (error) { setError(error.message); } finally { pending.current = false; setBusy(false); }
  }
  async function generate() { if (pending.current) return; pending.current = true; setBusy(true); setError(''); try { await submitJob('minutes'); } catch (error) { setError(error.message); } finally { pending.current = false; setBusy(false); } }
  const clarificationRecords = (meeting.followups || []).filter(item => ['resolved', 'recorded'].includes(item.status) && item.resolution);
  const currentEntries = meeting.topics?.filter(topic => !topic.mergedInto).flatMap(topic => (topic.entries || []).filter(entry => entry.status !== 'superseded' && !entry.stale).map(entry => ({ ...entry, topicTitle: topic.title }))) || [];
  return <Modal title={otherArtifacts.length ? '会议纪要与产物' : '会议纪要'} onClose={onClose} closeDisabled={busy} wide>
    <div className="minutes-toolbar"><div>{artifact ? <span className="muted">{artifact.author === 'host' ? '主持人修订' : artifact.author === 'agent' ? 'Agent 写入' : 'AI 整理'} · {formatDate(artifact.updatedAt)}{artifact.stale && <span className="stale-tag">来源或整理内容已更新</span>}</span> : <span className="muted">{awaitingSpeakers(meeting) ? '确认说话人后生成纪要' : '尚未保存纪要'}</span>}</div><div>{!editing && <><Button className="small" disabled={busy} onClick={() => setEditing(true)}><Pencil size={13} />{isDraft ? '审阅并采纳' : artifact ? '编辑' : '手动撰写'}</Button><Button className="small primary" busy={busy || generating} onClick={generate} disabled={awaitingSpeakers(meeting) || !meeting.transcriptRevision}><Sparkles size={13} />{generating ? '正在生成' : minutes && minutes.author !== 'ai' ? '生成更新草稿' : minutes ? '更新纪要' : '生成纪要'}</Button></>}</div></div>
    {!editing && (updateDraft || otherArtifacts.length > 0) && <div className="minutes-versions">{otherArtifacts.length ? <select aria-label="选择会议产物" value={artifactType} onChange={event => setArtifactType(event.target.value)}><option value="minutes">当前纪要</option>{updateDraft && <option value="minutes-draft">纪要更新草稿</option>}{otherArtifacts.map(item => <option key={item.id} value={item.type}>{item.title}{/^minutes-draft-/.test(item.type) ? ` ${item.type.slice(14)}` : ''}</option>)}</select> : <div className="segmented"><button className={artifactType === 'minutes' ? 'active' : ''} onClick={() => setArtifactType('minutes')}>当前纪要</button><button className={isDraft ? 'active' : ''} onClick={() => setArtifactType('minutes-draft')}>更新草稿</button></div>}<span>{isDraft ? '更新草稿保留原有纪要，审阅后可采纳。' : otherArtifacts.length ? 'Agent 写入的会议产物在这里同步显示。' : '更新草稿保留原有纪要，审阅后可采纳。'}</span></div>}
    <FormError error={error} />
    <div className="minutes-content">{editing ? <><label>{isMinutes ? '纪要标题' : '产物标题'}<input disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></label><label>正文 <span className="optional">Markdown</span><textarea disabled={busy} className="minutes-editor" value={markdown} onChange={event => setMarkdown(event.target.value)} placeholder="记下讨论结论、还要验证的事、不同意见，以及谁接下来要做什么。" /></label></> : artifact ? <div className="minutes-markdown"><h1>{artifact.title}</h1><MeetingMarkdown onEvidence={id => { onClose(); onEvidence(id); }}>{artifactMarkdown}</MeetingMarkdown></div> : <><EmptyState compact icon={FileText} title={generating ? '正在整理会议纪要' : '把讨论带到下一步'}>{generating ? '任务完成后，纪要会显示在这里。' : '基于本次会议生成纪要，或先查看已经整理出的结果。'}</EmptyState>{clarificationRecords.length > 0 && <section className="minutes-preview"><h3>澄清记录</h3>{clarificationRecords.map(item => <div key={item.id}><p className="minutes-clarification-question">{item.question}</p><ResolutionSummary item={item} onEvidence={id => { onClose(); onEvidence(id); }} /></div>)}</section>}{[['decision', '已作出的决定'], ['action', '行动项'], ['question', '未决问题']].map(([kind, label]) => { const entries = currentEntries.filter(entry => entry.type === kind && (kind !== 'question' || entry.status !== 'resolved')); return entries.length ? <section className="minutes-preview" key={kind}><h3>{label}</h3>{entries.map(entry => <div key={entry.id}><p>{entry.text}</p>{entry.owner && <span className="muted">{entry.owner}{entry.due ? ` · ${entry.due}` : ''}</span>}<Evidence ids={entry.evidenceIds} onSelect={id => { onClose(); onEvidence(id); }} /></div>)}</section> : null; })}</> }</div>
    <div className="modal-footer">{editing ? <><Button disabled={busy} onClick={() => setEditing(false)}>取消编辑</Button><Button className="primary" busy={busy} onClick={save} disabled={!markdown.trim() || !title.trim()}><Save size={14} />{isDraft ? '采纳并替换纪要' : (isMinutes ? '保存纪要' : '保存产物')}</Button></> : <><a className="button" href={`/api/meetings/${encodeURIComponent(meeting.id)}/export`} download><Download size={14} />导出会议</a>{artifact && <Button onClick={() => downloadText(`${meeting.title}-${isDraft ? '纪要更新草稿' : isMinutes ? '纪要' : artifact.title}.md`, `${artifact.stale ? `> 注意：本${isMinutes ? '纪要' : '产物'}所依据的原文或整理内容已更新，使用前请核对。\n\n` : ''}${artifactMarkdown}`)}><Download size={14} />导出{isDraft ? '草稿' : isMinutes ? '纪要' : '产物'}</Button>}<Button className="primary" onClick={onClose}>完成</Button></>}</div>
  </Modal>;
}

export function AgentDialog({ onClose }) {
  const [copied, setCopied] = useState(false);
  return <Modal title="让 Agent 参与会议" subtitle="工作台与 Agent 共用会议数据。Agent 的整理、问答和写回也会在这里公开显示。" onClose={onClose}>
    <div className="agent-guide"><div className="agent-guide-row"><Terminal size={19} /><div><h3>接入 MCP</h3><p>在本地 Agent 的 MCP 配置中，将此项目设为工作目录，通过下列命令启动服务。</p><button className="code-copy" onClick={async () => { try { await navigator.clipboard.writeText('node mcp/server.mjs'); setCopied(true); } catch { setCopied(false); } }}><code>node mcp/server.mjs</code>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></div><div className="agent-guide-row"><BookOpen size={19} /><div><h3>使用 meeting-workbench Skill</h3><p>在项目目录执行 <code>npm run skills:install</code>，然后让 Agent 创建会议、查询进展、围绕原文提问或整理纪要。具体配置见项目 README。</p></div></div><div className="agent-guide-row"><Mic size={19} /><div><h3>录音由当前浏览器采集</h3><p>Agent 请求开始录音时，这里会显示音频授权按钮。收到并保存真实音频后，页面与工具才会报告正在录音。</p></div></div></div><div className="modal-footer"><Button className="primary" onClick={onClose}>知道了</Button></div>
  </Modal>;
}
