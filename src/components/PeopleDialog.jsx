import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, LoaderCircle } from 'lucide-react';
import { api, formatTime, meetingPath } from '../lib/api.js';
import { Button, FormError, Modal } from './ui.jsx';
import './PeopleDialog.css';
import { speakerName, isUnassignedUtterance } from '../../shared/people.js';

const pending = job => job && ['queued', 'running'].includes(job.status);
const audioUrl = sample => `/api/recordings/${encodeURIComponent(sample.recordingId)}/audio?startSample=${sample.startSample}&endSample=${sample.endSample}`;

function TeamMember({ member, onSaved }) {
  const [name, setName] = useState(member.name);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className="people-member" onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { await api(`/api/members/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: { name: name.trim() } }); await onSaved(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }}><label>成员姓名<input aria-label={`${member.name}的姓名`} value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label><Button type="submit" busy={busy} disabled={!name.trim() || name.trim() === member.name}>保存</Button><FormError error={error} /></form>;
}

export default function PeopleDialog({ meeting, initialParticipantId, onClose, onChanged }) {
  const [data, setData] = useState(null), [runtime, setRuntime] = useState(null);
  const [tab, setTab] = useState('meeting'), [selectedId, setSelectedId] = useState(initialParticipantId || null);
  const [name, setName] = useState(''), [memberId, setMemberId] = useState('');
  const [sourceIds, setSourceIds] = useState([]), [mergeTarget, setMergeTarget] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [job, setJob] = useState(null), [playingId, setPlayingId] = useState(null);
  const selected = data?.participants.find(person => person.id === selectedId);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const result = await api(meetingPath(meeting.id, '/people'));
    const next = { ...result, participants: result.participants.filter(person => !isUnassignedUtterance(person)) };
    if (version !== loadVersion.current) return;
    setData(next); setSelectedId(current => next.participants.some(person => person.id === current) ? current : next.participants[0]?.id || null);
    return next;
  }, [meeting.id]);
  useEffect(() => { load().catch(failure => setError(failure.message)); api('/api/voiceprints/status').then(setRuntime).catch(() => setRuntime({ ready: false })); return () => { loadVersion.current++; }; }, [load]);
  useEffect(() => { setName(selected?.name || ''); setMemberId(selected?.memberId || ''); setSourceIds([]); setMergeTarget(''); setPlayingId(null); setNotice(''); setJob(null); }, [selectedId, selected?.id]);
  useEffect(() => { setName(selected?.name || ''); setMemberId(selected?.memberId || ''); }, [selected?.name, selected?.memberId]);
  const jobKey = `meeting-workbench:voiceprint-job:${meeting.id}:${selectedId}`;
  useEffect(() => {
    let current = true;
    try { const id = sessionStorage.getItem(jobKey); if (id) api(`/api/voiceprint-jobs/${encodeURIComponent(id)}`).then(result => { if (current) setJob(result.job); }).catch(() => sessionStorage.removeItem(jobKey)); } catch { /* Storage may be unavailable. */ }
    return () => { current = false; };
  }, [jobKey]);
  useEffect(() => {
    if (!pending(job)) return;
    let current = true;
    const timer = setInterval(async () => {
      try {
        const result = await api(`/api/voiceprint-jobs/${encodeURIComponent(job.id)}`);
        if (!current) return;
        setJob(result.job);
        if (!pending(result.job)) { await load(); if (result.job.status === 'done' && result.job.type === 'enroll') setNotice('声音样本已保存。'); }
      } catch (failure) { if (current) setError(failure.message); }
    }, 1200);
    return () => { current = false; clearInterval(timer); };
  }, [job?.id, job?.status, load]);

  async function change(action, message) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      const next = await load(); await onChanged?.();
      const updated = next?.participants.find(person => person.id === selectedId);
      if (updated) { setName(updated.name); setMemberId(updated.memberId || ''); }
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
    }, '姓名已保存，相关内容会同步更新。');
  }
  async function voiceprint(type, scope) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/voiceprints/${type}`), { method: 'POST', body: { sourceIds, ...(scope ? { scope } : {}) } });
      setJob(result.job); try { sessionStorage.setItem(jobKey, result.job.id); } catch { /* The task still runs without browser storage. */ }
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  const candidates = job?.status === 'done' ? job.result?.candidates || [] : [];
  const runtimeReady = runtime?.available === true || runtime?.ready === true;
  const profiles = (data?.profiles || []).filter(profile => profile.participantId === selectedId || selected?.memberId && profile.memberId === selected.memberId);
  return <Modal title="说话人" onClose={onClose} wide closeDisabled={busy}>
    <div className="people-dialog-content"><div className="people-tabs" role="tablist" aria-label="说话人范围"><button type="button" role="tab" aria-selected={tab === 'meeting'} onClick={() => setTab('meeting')}>这场会议</button><button type="button" role="tab" aria-selected={tab === 'team'} onClick={() => setTab('team')}>团队成员</button></div>
    <FormError error={error} />
    {notice && <p className="people-notice" role="status"><Check size={14} />{notice}</p>}
    {!data ? <p className="people-muted" role="status">正在读取说话人…</p> : tab === 'team' ? <div className="people-team"><p className="people-muted">成员姓名在关联的会议中保持一致。保存声音样本后，后续会议可以给出识别建议。</p>{data.members.length ? data.members.map(member => <TeamMember key={`${member.id}:${member.name}`} member={member} onSaved={async () => { await load(); await onChanged?.(); }} />) : <p className="people-muted">还没有团队成员。在本场说话人下标记姓名，即可加入团队。</p>}</div> : !data.participants.length ? <p className="people-muted">还没有区分出的说话人。可以在原文旁，为某段发言标记姓名。</p> : <div className={`people-layout ${selected ? 'has-selection' : ''}`}>
      <nav className="people-list" aria-label="本场说话人">{data.participants.map(person => <button type="button" key={person.id} aria-current={selectedId === person.id ? 'true' : undefined} onClick={() => { setSelectedId(person.id); setName(person.name || ''); setMemberId(person.memberId || ''); }}><strong>{speakerName(person.id, meeting)}</strong><span>{person.lineCount} 段发言{person.memberId ? ' · 团队成员' : ''}</span></button>)}</nav>
      {selected && <section className="people-detail" aria-label={`${speakerName(selected.id, meeting)}的说话人设置`}>
        <button type="button" className="people-back" onClick={() => setSelectedId(null)}><ChevronLeft size={15} />说话人列表</button>
        {selected.needsConfirmation && <p className="people-muted">这份旧录音曾重新连接。请回听确认这些发言是否来自同一个人。</p>}
        <form onSubmit={save} className="people-name-form"><label>姓名<input value={name} onChange={event => setName(event.target.value)} maxLength={100} required readOnly={Boolean(memberId && memberId !== 'new')} placeholder="填写这位参会者的姓名" /></label><label>关联团队成员<select value={memberId} onChange={event => { const next = event.target.value; setMemberId(next); const member = data.members.find(item => item.id === next); if (member) setName(member.name); }}><option value="">仅在本场会议使用</option>{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}<option value="new">加入团队成员</option></select></label><Button type="submit" className="primary" busy={busy} disabled={!name.trim()}>保存姓名</Button></form>
        <div className="people-samples"><h3>回听几段，确认是同一个人</h3>{selected.samples.length ? <><p className="people-muted">选 2–4 段清晰、没有其他人插话的发言，每段至少 3 秒。长发言只使用前 30 秒。</p><div className="people-sample-list">{selected.samples.map(sample => <div className={`people-sample ${sourceIds.includes(sample.id) ? 'is-selected' : ''}`} key={sample.id}><label><input type="checkbox" checked={sourceIds.includes(sample.id)} disabled={busy || pending(job) || sourceIds.length >= 4 && !sourceIds.includes(sample.id)} onChange={event => setSourceIds(previous => event.target.checked ? [...previous, sample.id] : previous.filter(id => id !== sample.id))} /><span><span className="people-sample-time">{formatTime(sample.startMs)} · {Math.round((sample.endSample - sample.startSample) / 16000)} 秒</span><span className="people-sample-copy">{sample.text}</span></span></label><button type="button" className="people-listen" onClick={() => setPlayingId(playingId === sample.id ? null : sample.id)}>{playingId === sample.id ? '收起回听' : '回听'}</button>{playingId === sample.id && <audio controls preload="metadata" src={audioUrl(sample)} aria-label={`回听 ${formatTime(sample.startMs)} 的发言`} />}</div>)}</div></> : <p className="people-muted">暂时没有足够长、能准确定位的录音片段。仍可先保存姓名。</p>}</div>
        <div className="people-voiceprint"><h3>声音识别</h3>{profiles.length > 0 && <p className="people-muted">已保存{selected.memberId ? '团队成员' : '本场会议'}声音样本。</p>}{!runtimeReady && <p className="people-muted">{runtime?.message || '本地声纹模型尚未就绪。姓名标记仍可使用，安装方式见项目使用说明。'}</p>}<div className="people-voice-actions"><Button onClick={() => voiceprint('match')} disabled={!runtimeReady || sourceIds.length < 2 || busy || pending(job)}>看看像哪位参会者</Button><Button onClick={() => voiceprint('enroll', selected.memberId ? 'team' : 'meeting')} disabled={!runtimeReady || sourceIds.length < 2 || selected.identitySource !== 'manual' || selected.needsConfirmation || busy || pending(job)}>{selected.memberId ? '保存团队声音样本' : '保存样本，仅用于本场'}</Button></div><p className="people-muted">先给出识别建议，确认后才会采用姓名。</p>
          {pending(job) && <div className="people-job" role="status"><LoaderCircle size={15} className="spin" /><span>正在本机处理声音… 可以关闭此窗口，稍后回来查看。</span><button type="button" onClick={async () => { try { const result = await api(`/api/voiceprint-jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} }); setJob(result.job); } catch (failure) { setError(failure.message); } }}>取消</button></div>}
          {job?.status === 'error' && <FormError error={typeof job.error === 'string' ? job.error : job.error?.message || '声音处理失败，请重新选择清晰片段。'} />}
          {job?.status === 'done' && job.type === 'match' && <div className="people-matches"><p>{candidates.length ? '可能是以下参会者，请结合回听确认。' : '暂时没有找到可靠的匹配，可以手动标记姓名。'}</p>{candidates.map((candidate, index) => <div className="people-match" key={candidate.memberId || candidate.participantId || index}><strong>{candidate.name || candidate.label || '待确认的参会者'}</strong><Button className="small" disabled={busy || !candidate.memberId && !candidate.participantId} onClick={() => change(() => candidate.memberId ? api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}`), { method: 'PATCH', body: { memberId: candidate.memberId } }) : api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/merge`), { method: 'POST', body: { targetId: candidate.participantId } }), '已确认，这位参会者的发言会同步更新。')}>确认是这位</Button></div>)}</div>}
        </div>
        {data.participants.length > 1 && <details className="people-merge"><summary>同一个人被分成了两组？</summary><label>合并到<select value={mergeTarget} onChange={event => setMergeTarget(event.target.value)}><option value="">选择另一组说话人</option>{data.participants.filter(person => person.id !== selected.id).map(person => <option key={person.id} value={person.id}>{speakerName(person.id, meeting)}</option>)}</select></label><Button disabled={!mergeTarget || busy || pending(job)} onClick={() => change(() => api(meetingPath(meeting.id, `/participants/${encodeURIComponent(selected.id)}/merge`), { method: 'POST', body: { targetId: mergeTarget } }), '已合并，相关分析会重新核对发言归属。')}>合并为同一人</Button></details>}
      </section>}
    </div>}
    </div>
  </Modal>;
}
