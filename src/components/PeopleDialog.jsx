import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, LoaderCircle } from 'lucide-react';
import { api, formatTime, meetingPath } from '../lib/api.js';
import { Button, FormError, Modal } from './ui.jsx';
import { speakerName, isUnassignedUtterance } from '../../shared/people.js';
import './PeopleDialog.css';

const pending = job => job && ['queued', 'running'].includes(job.status);
const audioUrl = sample => `/api/recordings/${encodeURIComponent(sample.recordingId)}/audio?startSample=${sample.startSample}&endSample=${sample.endSample}`;
const segmentSeconds = segment => Number.isFinite(segment.duration) ? segment.duration : Math.max(0, (segment.endSample - segment.startSample) / 16000);
const durationLabel = seconds => { const total = Math.round(seconds); return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`; };
const profileSegments = profile => profile.segments || [];
const usableProfile = profile => profile.enabled !== false && profile.available !== false;
const recognitionPending = person => ['queued', 'running'].includes(person?.recognition?.status);
const manualIdentity = person => person?.identitySource === 'manual';

function recognitionText(person) {
  if (manualIdentity(person)) return '已手动确认';
  if (person?.identitySource === 'voiceprint') return '声音自动识别';
  const recognition = person?.recognition;
  if (!recognition) return '';
  const labels = {
    waiting: '再等几句清晰发言', queued: '等待识别', running: '正在识别声音',
    matched: '声音自动识别', candidate: '有待确认的人选', unknown: '暂时没认出',
    error: '这次识别未完成', unavailable: '声音识别暂不可用', exhausted: '暂时没认出，可填写姓名或重新识别',
    confirmed: '已手动确认',
  };
  return labels[recognition.status] || '';
}

function ParticipantUtterances({ meetingId, participantId, lineCount, identityRevision, transcriptEditRevision, onPlaybackInfo }) {
  const [page, setPage] = useState(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [playingId, setPlayingId] = useState(null);
  const [audioError, setAudioError] = useState(null);
  const requestRef = useRef(null), pageRef = useRef(null), previousCount = useRef(lineCount);
  const latestCount = useRef(lineCount);
  latestCount.current = lineCount;
  const visibleLimit = useRef(3);
  const editKey = `${identityRevision || 0}:${transcriptEditRevision || 0}`;
  const currentEdit = useRef(editKey);
  currentEdit.current = editKey;
  const lastRequest = useRef({ cursor: 0, limit: 3, append: false });
  const loadPage = useCallback(async (cursor = 0, limit = 3, append = false) => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    lastRequest.current = { cursor, limit, append };
    const countAtRequest = latestCount.current;
    const editAtRequest = currentEdit.current;
    visibleLimit.current = Math.max(visibleLimit.current, Number(cursor) + limit);
    setLoading(true); setError('');
    try {
      let result, offset = cursor;
      const refreshed = [];
      do {
        result = await api(`${meetingPath(meetingId, `/participants/${encodeURIComponent(participantId)}/utterances`)}?cursor=${encodeURIComponent(offset)}&limit=${Math.min(100, limit - refreshed.length)}`, { signal: request.signal });
        if (requestRef.current !== request || request.signal.aborted || currentEdit.current !== editAtRequest) return;
        refreshed.push(...result.lines);
        offset = result.nextCursor;
      } while (offset != null && refreshed.length < limit && result.lines.length);
      result = { ...result, lines: refreshed };
      if (latestCount.current < countAtRequest) { loadPage(0, visibleLimit.current); return; }
      const previous = pageRef.current;
      const seen = new Set(append ? previous?.lines.map(line => line.id) : []);
      const next = { ...result, lines: append ? [...(previous?.lines || []), ...result.lines.filter(line => !seen.has(line.id))] : result.lines };
      if (latestCount.current > countAtRequest && latestCount.current > next.total) {
        next.total = latestCount.current;
        next.nextCursor ??= next.lines.length < next.total ? next.lines.length : null;
      }
      pageRef.current = next; setPage(next);
    } catch (failure) {
      if (requestRef.current === request && !request.signal.aborted && currentEdit.current === editAtRequest) setError(failure.message);
    } finally {
      if (requestRef.current === request && !request.signal.aborted && currentEdit.current === editAtRequest) { requestRef.current = null; setLoading(false); }
    }
  }, [meetingId, participantId]);
  useEffect(() => {
    // Corrections and attribution changes refresh only the range already open.
    // The scroll container and its existing rows stay mounted while it loads.
    loadPage(0, visibleLimit.current);
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [loadPage, editKey]);
  useEffect(() => {
    if (previousCount.current === lineCount) return;
    previousCount.current = lineCount;
    if (requestRef.current) return;
    const current = pageRef.current;
    // Keep an expanded reading position when new speech arrives. New speakers
    // and short previews can refresh without losing a page the host is reading.
    if (!current || current.lines.length <= 3 || lineCount < current.total) { loadPage(0, visibleLimit.current); return; }
    const next = { ...current, total: lineCount, nextCursor: current.nextCursor ?? (lineCount > current.lines.length ? current.lines.length : null) };
    pageRef.current = next; setPage(next);
  }, [lineCount, loadPage]);
  useEffect(() => {
    onPlaybackInfo({ meetingId, participantId, loaded: Boolean(page), count: page?.lines.length || 0, playable: page?.lines.filter(line => line.playbackAvailable).length || 0 });
  }, [page, meetingId, participantId, onPlaybackInfo]);
  return <section className="people-utterances" aria-label="这位说过什么">
    <div className="people-utterances-heading"><h4>这位说过什么</h4>{page && <span>{page.total} 段发言</span>}</div>
    {!page && loading && <p className="people-muted" role="status">正在读取发言…</p>}
    {page && !page.lines.length && <p className="people-muted">还没有这位说话人的原文。</p>}
    {page?.lines.length > 0 && <div className="people-utterance-list">{page.lines.map(line => <div className="people-utterance" key={line.id}>
      <div className="people-utterance-meta"><span>{formatTime(line.startMs)}{line.playbackAvailable && ` · ${segmentSeconds(line) < 3 ? `${Number(segmentSeconds(line).toFixed(2))} 秒` : durationLabel(segmentSeconds(line))}`}</span>{line.playbackAvailable && <button type="button" className="people-listen" aria-expanded={playingId === line.id} onClick={() => { setPlayingId(playingId === line.id ? null : line.id); setAudioError(null); }}>{playingId === line.id ? '收起回听' : line.playbackLabel || '回听'}</button>}</div>
      <p>{line.text}</p>
      {!line.playbackAvailable && <span className="people-utterance-unavailable">{line.playbackReason || '这段发言没有可回听的录音。'}</span>}
      {playingId === line.id && line.playbackAvailable && <audio controls preload="metadata" src={audioUrl(line)} aria-label={`回听 ${formatTime(line.startMs)} 的发言`} onError={() => setAudioError({ id: line.id, message: '这段录音暂时无法读取，可以稍后重试。' })} />}
      {audioError?.id === line.id && <p className="people-muted" role="status">{audioError.message}</p>}
    </div>)}</div>}
    <FormError error={error} />
    {error ? <Button className="text-button small" disabled={loading} onClick={() => { const { cursor, limit, append } = lastRequest.current; loadPage(cursor, limit, append); }}>重新读取发言</Button> : page?.nextCursor != null && <Button className="text-button small people-utterances-more" busy={loading} onClick={() => loadPage(page.nextCursor, 20, true)}>查看更多发言</Button>}
  </section>;
}

function SavedProfile({ profile, onChanged }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const enabled = profile.enabled !== false;
  return <div className={`people-saved-profile ${usableProfile(profile) ? '' : 'is-inactive'}`}>
    <div className="people-profile-heading"><div><strong>{profile.meetingTitle || '来源会议'}</strong><span>{!enabled ? '已停用' : profile.available === false ? '暂不可用' : `${profileSegments(profile).length} 段声音`}</span></div><Button className="text-button small" busy={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`/api/voiceprints/profiles/${encodeURIComponent(profile.id)}`, { method: 'PATCH', body: { enabled: !enabled } }); await onChanged(); }
      catch (failure) { setError(failure.message); } finally { setBusy(false); }
    }}>{enabled ? '停用' : '恢复使用'}</Button></div>
    {enabled && profile.available === false && <p className="people-muted">{profile.unavailableMessage || '这些样本暂时不能用于识别，可以回听后补充新样本。'}</p>}
    <div className="people-saved-segments">{profileSegments(profile).map((segment, index) => {
      const key = `${segment.sourceId}:${index}`;
      return <div className="people-saved-segment" key={key}><span>片段 {index + 1}<span className="people-segment-duration">{durationLabel(segmentSeconds(segment))}</span></span><button type="button" className="people-listen" aria-expanded={playing === key} onClick={() => setPlaying(playing === key ? null : key)}>{playing === key ? '收起' : '回听'}</button>{playing === key && <audio controls preload="metadata" src={audioUrl(segment)} aria-label={`回听${profile.meetingTitle || '来源会议'}的声音片段 ${index + 1}`} onError={() => setError('这段录音暂时无法读取。')} />}</div>;
    })}</div><FormError error={error} />
  </div>;
}

function TeamMember({ member, profiles, onSaved }) {
  const [name, setName] = useState(member.name);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const activeSegments = profiles.filter(usableProfile).flatMap(profileSegments);
  useEffect(() => { setName(member.name); }, [member.name]);
  return <details className="people-team-member" onToggle={event => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll('audio').forEach(audio => audio.pause()); }}>
    <summary><span><strong>{member.name}</strong><span className="people-member-summary">{activeSegments.length ? `声音已登记 ${activeSegments.length} 段 · ${durationLabel(activeSegments.reduce((sum, segment) => sum + segmentSeconds(segment), 0))}` : profiles.length ? '声音样本已停用或暂不可用' : '尚未登记声音'}</span></span><ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="people-member-detail"><form className="people-member" onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError('');
      try { await api(`/api/members/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: { name: name.trim() } }); await onSaved(); }
      catch (failure) { setError(failure.message); } finally { setBusy(false); }
    }}><label>成员姓名<input aria-label={`${member.name}的姓名`} value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label><Button type="submit" busy={busy} disabled={!name.trim() || name.trim() === member.name}>保存</Button><FormError error={error} /></form>
    {profiles.length ? <div className="people-profile-list">{profiles.map(profile => <SavedProfile key={profile.id} profile={profile} onChanged={onSaved} />)}</div> : <p className="people-muted">在会议里确认这位成员的姓名后，展开“登记声音”，选几段发言保存即可。</p>}</div>
  </details>;
}

export default function PeopleDialog({ meeting, initialParticipantId, onClose, onChanged }) {
  const [data, setData] = useState(null), [runtime, setRuntime] = useState(null);
  const [allProfiles, setAllProfiles] = useState(null), [profileError, setProfileError] = useState('');
  const [tab, setTab] = useState('meeting'), [selectedId, setSelectedId] = useState(initialParticipantId || null);
  const [name, setName] = useState(''), [memberId, setMemberId] = useState('');
  const [sourceIds, setSourceIds] = useState([]), [mergeTarget, setMergeTarget] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [job, setJob] = useState(null), [playingId, setPlayingId] = useState(null);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [playbackInfo, setPlaybackInfo] = useState(null);
  const updatePlaybackInfo = useCallback(value => setPlaybackInfo(value), []);
  const selected = data?.participants.find(person => person.id === selectedId);
  const loadVersion = useRef(0), profileVersion = useRef(0), identitySignature = useRef(null);
  const identityDirty = useRef(false), onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const result = await api(meetingPath(meeting.id, '/people'));
    const next = { ...result, participants: result.participants.filter(person => !isUnassignedUtterance(person)) };
    if (version !== loadVersion.current) return;
    const signature = JSON.stringify(next.participants.map(person => [person.id, person.name, person.memberId, person.identitySource]));
    const changed = identitySignature.current !== null && identitySignature.current !== signature;
    identitySignature.current = signature;
    setData(next); setSelectedId(current => current === null ? null : next.participants.some(person => person.id === current) ? current : next.participants[0]?.id || null);
    if (changed) await onChangedRef.current?.();
    return next;
  }, [meeting.id]);
  const loadProfiles = useCallback(async () => {
    const version = ++profileVersion.current;
    try {
      const result = await api('/api/voiceprints/profiles');
      if (version === profileVersion.current) { setAllProfiles(result.profiles || []); setProfileError(''); }
    } catch (failure) { if (version === profileVersion.current) setProfileError(failure.message); }
  }, []);
  useEffect(() => {
    let current = true;
    load().then(next => { if (current) setSelectedId(id => id || next?.participants[0]?.id || null); }).catch(failure => { if (current) setError(failure.message); });
    loadProfiles();
    api('/api/voiceprints/status').then(result => { if (current) setRuntime(result); }).catch(() => { if (current) setRuntime({ ready: false }); });
    return () => { current = false; loadVersion.current++; profileVersion.current++; };
  }, [load, loadProfiles]);
  useEffect(() => {
    identityDirty.current = false;
    setName(selected?.name || ''); setMemberId(selected?.memberId || ''); setSourceIds([]);
    setMergeTarget(''); setPlayingId(null); setNotice(''); setError(''); setJob(null); setSamplesOpen(false);
  }, [selectedId]);
  useEffect(() => { if (!identityDirty.current) { setName(selected?.name || ''); setMemberId(selected?.memberId || ''); } }, [selected?.name, selected?.memberId]);
  const enrollmentJob = (data?.voiceprintJobs || []).filter(item => item.participantId === selectedId && item.type === 'enroll').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const serverJobId = pending(enrollmentJob) ? enrollmentJob.id : selected?.recognition?.jobId || enrollmentJob?.id;
  useEffect(() => {
    if (!serverJobId) return;
    let current = true;
    api(`/api/voiceprint-jobs/${encodeURIComponent(serverJobId)}`).then(result => { if (current) setJob(previous => pending(previous) && previous.id !== serverJobId ? previous : result.job); }).catch(() => {});
    return () => { current = false; };
  }, [selectedId, serverJobId]);
  const working = pending(job) || data?.participants.some(recognitionPending);
  useEffect(() => {
    let current = true, refreshing = false;
    const timer = setInterval(async () => {
      if (document.hidden || refreshing) return;
      refreshing = true;
      try { await load(); if (current && tab === 'team') await loadProfiles(); }
      catch (failure) { if (current) setError(failure.message); }
      finally { refreshing = false; }
    }, working ? 2500 : 7000);
    return () => { current = false; clearInterval(timer); };
  }, [load, loadProfiles, working, tab]);
  useEffect(() => {
    if (!pending(job)) return;
    let current = true, refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await api(`/api/voiceprint-jobs/${encodeURIComponent(job.id)}`);
        if (!current) return;
        setJob(result.job);
        if (!pending(result.job)) {
          await load(); await loadProfiles();
          if (current && result.job.status === 'done' && result.job.type === 'enroll') { setNotice('声音样本已保存。'); setSourceIds([]); setSamplesOpen(false); }
        }
      } catch (failure) { if (current) setError(failure.message); }
      finally { refreshing = false; }
    }, 1200);
    return () => { current = false; clearInterval(timer); };
  }, [job?.id, job?.status, load, loadProfiles]);

  async function change(action, message) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      identityDirty.current = false;
      const next = await load(); await onChangedRef.current?.();
      const updated = next?.participants.find(person => person.id === selectedId);
      if (updated) { setName(updated.name || ''); setMemberId(updated.memberId || ''); }
      setJob(previous => previous?.type === 'enroll' ? previous : null);
      setNotice(result?.refreshJob?.status === 'error' ? `姓名已保存；相关分析暂未更新：${result.refreshJob.error}` : message);
      return result;
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    if (!selected || !name.trim()) return;
    await change(async () => {
      let targetMember = memberId;
      if (targetMember === 'new') {
        const member = await api('/api/members', { method: 'POST', body: { name: name.trim() } });
        targetMember = member.id; setMemberId(member.id);
        setData(previous => ({ ...previous, members: [...previous.members, member] }));
      }
      return api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}`), { method: 'PATCH', body: { name: name.trim(), memberId: targetMember || null } });
    }, '姓名已确认，自动识别不会再改名。');
  }
  async function identify() {
    if (!selected || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/recognition/retry`), { method: 'POST', body: {} });
      setJob(result.job || null); await load();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function enroll() {
    if (!selected || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/voiceprints/enroll`), { method: 'POST', body: { sourceIds, scope: selected.memberId ? 'team' : 'meeting' } });
      setJob(result.job); await load();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  const recognition = selected?.recognition;
  const candidates = manualIdentity(selected) || selected?.identitySource === 'voiceprint' || recognition?.status !== 'candidate' ? [] : recognition.candidates || [];
  const runtimeReady = runtime?.available === true || runtime?.ready === true;
  const profiles = (data?.profiles || []).filter(profile => selected?.memberId ? profile.memberId === selected.memberId : profile.scope === 'meeting' && profile.participantId === selectedId);
  const selectedSamples = selected?.samples || [];
  // Keep the meeting's participant order for the shared fallback labels. Hidden
  // unknown utterances must not renumber the visible speakers in this dialog.
  const latestPeople = new Map((data?.participants || []).map(person => [person.id, person]));
  const knownIds = new Set((meeting.participants || []).map(person => person.id));
  const personMeeting = { ...meeting, participants: [...(meeting.participants || []).map(person => latestPeople.get(person.id) || person), ...(data?.participants || []).filter(person => !knownIds.has(person.id))] };
  const hasRegisteredName = person => Boolean(person.memberId || person.name?.trim() || person.speakerIds?.some(id => personMeeting.speakerLabels?.[id]?.trim()));
  const mergeTargets = (data?.participants || []).filter(person => person.id !== selectedId)
    .sort((a, b) => Number(hasRegisteredName(b)) - Number(hasRegisteredName(a)));
  const processing = pending(job) || recognitionPending(selected);
  const registered = profiles.filter(usableProfile).flatMap(profileSegments).length;
  const selectedStatus = recognitionText(selected);
  const canIdentify = selected && !manualIdentity(selected) && !selected.name?.trim() && !selected.memberId;
  const enoughSamples = selectedSamples.length >= 2;
  const sampleWaitMessage = meeting.status === 'ended' || meeting.status === 'archived' ? '发言太短，暂不能识别姓名' : '再等几句较长的发言';
  const shownPlayback = playbackInfo?.meetingId === meeting.id && playbackInfo.participantId === selectedId ? playbackInfo : null;
  const noSampleMessage = `${shownPlayback?.playable ? shownPlayback.playable === shownPlayback.count ? '上方发言可以回听，但' : '上方部分发言可以回听，但' : ''}暂时没有适合登记声音的片段（每段至少 3 秒、4 个字）。`;

  return <Modal title="说话人" onClose={onClose} wide closeDisabled={busy}>
    <div className="people-dialog-content">
      <div className="people-tabs" role="tablist" aria-label="说话人范围"><button type="button" role="tab" aria-selected={tab === 'meeting'} disabled={busy} onClick={() => { setTab('meeting'); setPlayingId(null); }}>这场会议</button><button type="button" role="tab" aria-selected={tab === 'team'} disabled={busy} onClick={() => { setTab('team'); setPlayingId(null); loadProfiles(); }}>团队成员</button></div>
      <FormError error={error} />
      {notice && <p className="people-notice" role="status"><Check size={14} />{notice}</p>}
      {!data ? <p className="people-muted" role="status">正在读取说话人…</p> : tab === 'team' ? <div className="people-team">
        <FormError error={profileError} />
        {allProfiles === null && !profileError ? <p className="people-muted" role="status">正在读取声音样本…</p> : data.members.length ? data.members.map(member => <TeamMember key={member.id} member={member} profiles={(allProfiles || []).filter(profile => profile.memberId === member.id)} onSaved={async () => { await load(); await loadProfiles(); await onChangedRef.current?.(); }} />) : <p className="people-muted">还没有团队成员。在这场会议里保存姓名时，可以选择加入团队。</p>}
      </div> : !data.participants.length ? <p className="people-muted">还没有区分出的说话人。可以在原文旁，为某段发言标记姓名。</p> : <div className={`people-layout ${selected ? 'has-selection' : ''}`}>
        <nav className="people-list" aria-label="本场说话人">{data.participants.map(person => <button type="button" key={person.id} disabled={busy} aria-current={selectedId === person.id ? 'true' : undefined} onClick={() => setSelectedId(person.id)}><strong>{speakerName(person.id, personMeeting)}</strong><span>{person.lineCount} 段发言{person.memberId ? ' · 团队成员' : ''}</span>{(person.identitySource === 'voiceprint' || person.recognition?.status === 'candidate') && <span className="people-list-recognition">{person.identitySource === 'voiceprint' ? '自动识别' : '待确认姓名'}</span>}</button>)}</nav>
        {selected && <section className="people-detail" aria-label={`${speakerName(selected.id, personMeeting)}的说话人设置`}>
          <button type="button" className="people-back" disabled={busy} onClick={() => setSelectedId(null)}><ChevronLeft size={15} />说话人列表</button>
          <div className="people-recognition"><div className="people-recognition-heading"><div><h3>{speakerName(selected.id, personMeeting)}</h3>{selectedStatus && !(canIdentify && !enoughSamples && ['waiting', 'unknown', 'exhausted'].includes(recognition?.status)) && <p className="people-muted" role={processing ? 'status' : undefined}>{processing && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{selectedStatus}</p>}</div>{canIdentify && <div className="people-identify-action"><Button className="small" busy={busy && !pending(job)} disabled={!runtimeReady || processing || busy || !enoughSamples} onClick={identify}>{recognition?.attempts || selected.identitySource === 'voiceprint' || recognition?.jobId ? '重新识别' : '识别这位说话人'}</Button>{!enoughSamples && <span className="people-muted">{sampleWaitMessage}</span>}</div>}</div>
            {selected.needsConfirmation && <p className="people-muted">这份旧录音曾重新连接。请回听确认这些发言是否来自同一个人。</p>}
            {candidates.length > 0 && <div className="people-matches"><p>可能是以下参会者</p>{candidates.map((candidate, index) => <div className="people-match" key={candidate.profileId || candidate.memberId || candidate.participantId || index}><strong>{candidate.name || candidate.label || '待确认的参会者'}</strong><Button className="small" disabled={busy || !candidate.memberId && !candidate.participantId} onClick={() => change(() => candidate.memberId ? api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}`), { method: 'PATCH', body: { memberId: candidate.memberId } }) : api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/merge`), { method: 'POST', body: { targetId: candidate.participantId } }), '姓名已确认，自动识别不会再改名。')}>确认是这位</Button></div>)}</div>}
            {!runtimeReady && !manualIdentity(selected) && <p className="people-muted">声音识别暂不可用，可以直接填写姓名。</p>}
            {recognition?.status === 'error' && <p className="people-muted">{recognition.error || '这次没能完成识别，可以稍后重试或直接填写姓名。'}</p>}
            {recognition?.analysisStatus === 'error' && <p className="people-muted">姓名已更新，相关讨论暂未完成核对。</p>}
          </div>
          <ParticipantUtterances key={`${meeting.id}:${selected.id}`} meetingId={meeting.id} participantId={selected.id} lineCount={selected.lineCount} identityRevision={meeting.identityRevision} transcriptEditRevision={meeting.transcriptEditRevision} onPlaybackInfo={updatePlaybackInfo} />
          <form onSubmit={save} className="people-name-form"><label>姓名<input value={name} onChange={event => { identityDirty.current = true; setName(event.target.value); }} maxLength={100} required readOnly={Boolean(memberId && memberId !== 'new')} placeholder="填写这位参会者的姓名" /></label><label>是否是团队成员<select value={memberId} onChange={event => { identityDirty.current = true; const next = event.target.value; setMemberId(next); const member = data.members.find(item => item.id === next); if (member) setName(member.name); }}><option value="">仅在这场会议标记</option>{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}<option value="new">加入团队成员</option></select></label><div className="people-name-actions"><Button type="submit" className="primary" busy={busy} disabled={!name.trim() || manualIdentity(selected) && name.trim() === selected.name && memberId === (selected.memberId || '')}>{manualIdentity(selected) ? '保存姓名' : '确认姓名'}</Button>{manualIdentity(selected) && <span className="people-muted">自动识别不会改动已确认的姓名。</span>}</div></form>
          {pending(job) && <div className="people-job" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /><span>{job.type === 'enroll' ? '正在保存声音样本…' : '正在识别声音…'} 可以关闭窗口。</span><button type="button" onClick={async () => { try { const result = await api(`/api/voiceprint-jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} }); setJob(result.job); await load(); } catch (failure) { setError(failure.message); } }}>取消</button></div>}
          {job?.status === 'error' && <FormError error={typeof job.error === 'string' ? job.error : job.error?.message || '声音处理未完成，可以稍后重试。'} />}
          <details className="people-enrollment" open={samplesOpen} onToggle={event => { setSamplesOpen(event.currentTarget.open); if (!event.currentTarget.open) setPlayingId(null); }}>
            <summary><span>{registered ? '补充声音样本' : '登记声音'}{registered > 0 && <span className="people-muted">已保存 {registered} 段</span>}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="people-enrollment-content"><p className="people-muted">{selected.memberId ? '保存后，下次会议可以自动认出这位成员。' : '保存后，用于辨认本场会议里这位访客的后续发言。'}{selectedSamples.length > 0 && ' 选 2–4 段清晰、没有其他人插话的发言，每段至少 3 秒、4 个字；长发言使用前 30 秒。'}</p>
              {!manualIdentity(selected) || selected.needsConfirmation ? <p className="people-muted">请先确认姓名，再登记声音。</p> : null}
              {selectedSamples.length ? <div className="people-sample-list">{selectedSamples.map(sample => <div className={`people-sample ${sourceIds.includes(sample.id) ? 'is-selected' : ''}`} key={sample.id}><label><input type="checkbox" checked={sourceIds.includes(sample.id)} disabled={busy || processing || sourceIds.length >= 4 && !sourceIds.includes(sample.id)} onChange={event => setSourceIds(previous => event.target.checked ? [...previous, sample.id] : previous.filter(id => id !== sample.id))} /><span><span className="people-sample-time">{formatTime(sample.startMs)} · {durationLabel(segmentSeconds(sample))}</span><span className="people-sample-copy">{sample.text}</span></span></label><button type="button" className="people-listen" aria-expanded={playingId === sample.id} onClick={() => setPlayingId(playingId === sample.id ? null : sample.id)}>{playingId === sample.id ? '收起' : '回听'}</button>{playingId === sample.id && <audio controls preload="metadata" src={audioUrl(sample)} aria-label={`回听 ${formatTime(sample.startMs)} 的发言`} onError={() => setError('这段录音暂时无法读取。')} />}</div>)}</div> : <p className="people-muted">{noSampleMessage}</p>}
              <div className="people-voice-actions"><Button onClick={enroll} disabled={!runtimeReady || sourceIds.length < 2 || !manualIdentity(selected) || selected.needsConfirmation || busy || processing}>{selected.memberId ? '保存团队声音样本' : '保存本场声音样本'}</Button>{sourceIds.length > 0 && <span className="people-muted">已选 {sourceIds.length} 段</span>}</div>
            </div>
          </details>
          {data.participants.length > 1 && <details className="people-merge"><summary>同一个人被分成了两组？<ChevronDown size={15} aria-hidden="true" /></summary><div className="people-merge-content"><label>合并到<select value={mergeTarget} onChange={event => setMergeTarget(event.target.value)}><option value="">选择另一组说话人</option>{mergeTargets.map(person => <option key={person.id} value={person.id}>{speakerName(person.id, personMeeting)}</option>)}</select></label><Button disabled={!mergeTarget || busy || processing} onClick={() => change(() => api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/merge`), { method: 'POST', body: { targetId: mergeTarget } }), '已合并为同一个人。')}>合并为同一人</Button></div></details>}
        </section>}
      </div>}
    </div>
  </Modal>;
}
