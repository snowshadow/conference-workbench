import { speakerName as participantName } from '../../shared/people.js';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position } from '@xyflow/react';
import { ChevronDown, ChevronRight, CircleHelp, GitBranch, ListTree, Map, Merge, Pencil, Plus, Quote, Scissors, Sparkles, Target, CheckCheck, UserRound, CalendarDays } from 'lucide-react';
import { Button, EmptyState, Evidence, FormError, IconButton, Modal, useFormAction } from './ui.jsx';
import { isCurrentEntry, topicReadingEntries } from '../../shared/discussion-view.js';
import { buildTopicMap } from '../lib/topic-map.js';
import '@xyflow/react/dist/style.css';
import './TopicNavigation.css';

const kinds = { viewpoint: { label: '观点与依据', icon: Quote }, question: { label: '待澄清问题', icon: CircleHelp }, decision: { label: '决定', icon: CheckCheck }, action: { label: '行动项', icon: Target } };
const statusNames = { active: '当前有效', open: '待处理', resolved: '已解决', superseded: '已替代' };

function TopicForm({ meeting, topic, mode, onClose, mutate }) {
  const [title, setTitle] = useState(mode === 'edit' ? topic.title : '');
  const [summary, setSummary] = useState(mode === 'edit' ? topic.summary || '' : '');
  const [parentId, setParentId] = useState(mode === 'edit' ? topic.parentId || '' : '');
  const [targetId, setTargetId] = useState('');
  const [entryIds, setEntryIds] = useState([]);
  const descendants = new Set(topic ? [topic.id] : []);
  for (let i = 0; i < meeting.topics.length; i++) for (const item of meeting.topics) if (descendants.has(item.parentId)) descendants.add(item.id);
  const topics = meeting.topics.filter(item => !item.mergedInto && !descendants.has(item.id));
  const { submit, error, busy } = useFormAction(async () => {
    if (mode === 'merge') await mutate(`/topics/${topic.id}/merge`, 'POST', { targetId });
    else if (mode === 'edit') await mutate(`/topics/${topic.id}`, 'PATCH', { title: title.trim(), summary: summary.trim(), parentId: parentId || null });
    else await mutate('/topics', 'POST', { title: title.trim(), parentId: parentId || null, ...(mode === 'split' ? { entryIds } : {}) });
    onClose();
  });
  return <Modal title={{ edit: '修正主题', add: '新建主题', split: '拆分主题', merge: '合并主题' }[mode]} subtitle={mode === 'merge' ? '条目与原文引用将移入目标主题，保留主题来源关系。' : mode === 'split' ? '选择要移出的条目，为它们建立一个新主题。' : '人工修正会保留，后续自动整理不会静默覆盖。'} onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit}>
      {mode === 'merge' ? <label>合并到<select value={targetId} onChange={event => setTargetId(event.target.value)} required><option value="">选择目标主题</option>{topics.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : <>
        <label>主题名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="例如：首批用户与试点范围" required /></label>
        {mode === 'edit' && <label>主题概述<textarea value={summary} onChange={event => setSummary(event.target.value)} rows={3} placeholder="概括讨论内容，不补充未说过的事实" /></label>}
        <label>所属主题<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">一级主题</option>{topics.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {mode === 'split' && <div className="entry-picker">{topic.entries?.length ? topic.entries.map(entry => <label className="checkbox-label" key={entry.id}><input type="checkbox" checked={entryIds.includes(entry.id)} onChange={event => setEntryIds(previous => event.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id))} /><span>{entry.text}</span></label>) : <p className="muted">这个主题还没有可拆分的条目。</p>}</div>}
      </>}
      <FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button className="primary" type="submit" busy={busy} disabled={mode === 'merge' ? !targetId : !title.trim() || (mode === 'split' && !entryIds.length)}>{mode === 'merge' ? '合并主题' : '保存主题'}</Button></div>
    </form>
  </Modal>;
}

function EntryForm({ entry, onClose, mutate }) {
  const [draft, setDraft] = useState({ text: entry.text, type: entry.type, status: entry.status || 'active', owner: entry.owner || '', due: entry.due || '' });
  const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const { submit, error, busy } = useFormAction(async () => { await mutate(`/entries/${entry.id}`, 'PATCH', draft); onClose(); });
  return <Modal title="修正讨论条目" subtitle="负责人、时间只填写会议中已明确的信息。" onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit}>
      <div className="form-row"><label>类型<select value={draft.type} onChange={event => change('type', event.target.value)}>{Object.entries(kinds).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label><label>状态<select value={draft.status} onChange={event => change('status', event.target.value)}>{Object.entries(statusNames).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label></div>
      <label>内容<textarea autoFocus value={draft.text} onChange={event => change('text', event.target.value)} rows={5} required /></label>
      {draft.type === 'action' && <div className="form-row"><label>负责人<input value={draft.owner} onChange={event => change('owner', event.target.value)} placeholder="未明确可留空" /></label><label>完成时间<input value={draft.due} onChange={event => change('due', event.target.value)} placeholder="沿用会议中的表述" /></label></div>}
      <FormError error={error} /><div className="modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="primary" busy={busy} disabled={!draft.text.trim()}>保存修正</Button></div>
    </form>
  </Modal>;
}

const TopicNode = memo(function TopicNode({ data, selected }) {
  return <div className={`topic-node ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="topic-node-heading" title={data.title}><span className="node-dot" /><span>{data.title}</span></div>
    <div className="topic-node-meta"><span>{data.entryCount} 条讨论</span>{data.childCount > 0 && <button type="button" className="nodrag nopan" title={data.folded ? '展开下级主题' : '折叠下级主题'} aria-label={`${data.folded ? '展开' : '折叠'} ${data.title} 的下级主题`} aria-expanded={!data.folded} onClick={event => { event.stopPropagation(); data.onFold(data.id); }}>{data.folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{data.childCount}</button>}</div>
    <Handle type="source" position={Position.Right} />
  </div>;
});
const MeetingNode = memo(function MeetingNode({ data }) {
  return <div className="topic-node meeting-map-root" title={data.title}>
    <span className="meeting-map-label">会议</span><strong className="meeting-map-title">{data.title}</strong>
    <Handle type="source" position={Position.Right} />
  </div>;
});
const nodeTypes = { topic: TopicNode, meeting: MeetingNode };

function TopicMap({ topics, meetingTitle, selected, setSelected, folded, toggleFold, viewport }) {
  const graph = useMemo(() => buildTopicMap({ topics, meetingTitle, selected, folded, onFold: toggleFold }), [topics, meetingTitle, selected, folded, toggleFold]);
  return <div className="mindmap"><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => { if (node.type === 'topic') setSelected(node.id); }} onMoveEnd={(_, position) => { viewport.current = position; }} onInit={instance => { if (viewport.current) instance.setViewport(viewport.current); else requestAnimationFrame(() => instance.fitView({ padding: 0.25, maxZoom: 1 })); }} nodesDraggable={false} nodesConnectable={false} minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大导图', 'controls.zoomOut.ariaLabel': '缩小导图', 'controls.fitView.ariaLabel': '显示全部主题' }}><Background color="var(--map-grid)" gap={20} size={1} /><Controls showInteractive={false} /></ReactFlow><span className="map-caption">滚轮缩放 · 拖动平移 · 点击主题查看详情</span></div>;
}

function Outline({ topics, selected, setSelected, folded, toggleFold }) {
  const ids = new Set(topics.map(topic => topic.id));
  const roots = topics.filter(topic => !topic.parentId || !ids.has(topic.parentId));
  const visited = new Set();
  function render(topic, depth = 0) {
    if (visited.has(topic.id)) return null;
    visited.add(topic.id);
    const children = topics.filter(item => item.parentId === topic.id);
    const isFolded = folded.has(topic.id);
    const groupId = `outline-children-${topic.id}`;
    return <div key={topic.id}>
      <div className={`outline-item ${selected === topic.id ? 'selected' : ''}`} style={{ paddingLeft: 7 + depth * 15 }}>
        <button type="button" className="outline-select" title={topic.title} aria-pressed={selected === topic.id} onClick={() => setSelected(topic.id)}><span className="outline-marker" aria-hidden="true" /><span className="outline-title">{topic.title}</span><small>{topic.entries?.filter(isCurrentEntry).length || 0}</small></button>
        {children.length ? <IconButton className="outline-fold" title={isFolded ? '展开下级主题' : '折叠下级主题'} aria-label={`${isFolded ? '展开' : '折叠'} ${topic.title} 的下级主题`} aria-expanded={!isFolded} aria-controls={groupId} onClick={() => toggleFold(topic.id)}>{isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</IconButton> : <span className="outline-fold-placeholder" aria-hidden="true" />}
      </div>{children.length > 0 && <div id={groupId} role="group" aria-label={`${topic.title} 的下级主题`} hidden={isFolded}>{children.map(child => render(child, depth + 1))}</div>}
    </div>;
  }
  return <nav className="outline-tree" aria-label="会议主题">{roots.map(topic => render(topic))}</nav>;
}

function DiscussionEntry({ entry, meeting, onEdit, onEvidence }) {
  const author = entry.manualFields?.length || entry.author === 'host' ? '主持人修订' : entry.author === 'agent' ? 'Agent 写入' : null;
  const note = [author, entry.status === 'resolved' ? statusNames.resolved : null].filter(Boolean).join(' · ');
  return <article className="discussion-entry">
    {entry.participantIds?.length > 0 && <div className="entry-speakers">{[...new Set(entry.participantIds.map(id => participantName(id, meeting)).filter(Boolean))].join('、')}</div>}
    <div className="entry-copy"><p>{entry.text}</p><IconButton title="修正条目" className="entry-edit" onClick={() => onEdit(entry)}><Pencil size={13} /></IconButton></div>
    {(entry.owner || entry.due) && <div className="entry-assignee">{entry.owner && <span><UserRound size={12} />{entry.owner}</span>}{entry.due && <span><CalendarDays size={12} />{entry.due}</span>}</div>}
    {(entry.evidenceIds?.length > 0 || note) && <div className="entry-footer"><Evidence ids={entry.evidenceIds} onSelect={onEvidence} />{note && <span className="entry-origin">{note}</span>}</div>}
  </article>;
}

function EntryGroups({ entries, meeting, onEdit, onEvidence }) {
  return ['decision', 'action', 'question', 'viewpoint'].map(key => {
    const group = entries.filter(entry => entry.type === key);
    const { label } = kinds[key];
    return group.length ? <section className={`entry-group ${key}`} key={key}><h4>{label}</h4>{group.map(entry => <DiscussionEntry key={entry.id} entry={entry} meeting={meeting} onEdit={onEdit} onEvidence={onEvidence} />)}</section> : null;
  });
}

function TopicPanel({ meeting, selected, setSelected, onEvidence, mutate, onAskTopic }) {
  const [view, setView] = useState('outline');
  const [folded, setFolded] = useState(new Set());
  const [modal, setModal] = useState(null);
  const viewport = useRef(null);
  const topicsKey = JSON.stringify(meeting.topics || []);
  const topics = useMemo(() => (meeting.topics || []).filter(topic => !topic.mergedInto), [topicsKey]);
  const topic = topics.find(item => item.id === selected);
  useEffect(() => { if (!selected && topics.length) setSelected(topics[0].id); else if (selected && !topics.some(item => item.id === selected)) { const merged = meeting.topics.find(item => item.id === selected); setSelected(merged?.mergedInto || topics[0]?.id || null); } }, [topics, selected, setSelected, meeting.topics]);
  const toggleFold = useCallback(id => setFolded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const entries = topic?.entries || [];
  const readingEntries = topicReadingEntries(entries);
  const needsReview = topic?.stale || entries.some(entry => entry.stale && entry.status !== 'superseded' && !(entry.type === 'question' && entry.status === 'resolved'));
  const editEntry = entry => setModal({ mode: 'entry', entry });
  return <div className="topic-panel-content">
    <div className="topic-toolbar"><div className="segmented" aria-label="主题视图"><button className={view === 'outline' ? 'active' : ''} onClick={() => setView('outline')} aria-pressed={view === 'outline'}><ListTree size={14} />大纲</button><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')} aria-pressed={view === 'map'}><Map size={14} />导图</button></div><span className="subtle-count">{topics.length} 个主题</span><Button className="text-button small" onClick={() => setModal({ mode: 'add' })}><Plus size={14} />新建主题</Button></div>
    {!topics.length ? <EmptyState icon={GitBranch} title="沿着原话找到相关讨论" action={<div className="empty-flow"><span>记录发言</span><ChevronRight size={13} /><span>连接主题</span><ChevronRight size={13} /><span>形成决定</span></div>}>开始录音或补充会议原文后，AI 会连接相关主题，帮助定位概念、前提和决定的原话。</EmptyState> : <div className={`topic-layout view-${view}`}>
      {view === 'outline' ? <Outline topics={topics} selected={selected} setSelected={setSelected} folded={folded} toggleFold={toggleFold} /> : <TopicMap topics={topics} meetingTitle={meeting.title} selected={selected} setSelected={setSelected} folded={folded} toggleFold={toggleFold} viewport={viewport} />}
      {topic && <div className="topic-detail" key={topic.id}>
        <div className="topic-detail-heading"><span className="eyebrow">当前主题</span><div className="topic-detail-actions"><IconButton title="修正主题" onClick={() => setModal({ mode: 'edit', topic })}><Pencil size={14} /></IconButton><IconButton title="拆分主题" onClick={() => setModal({ mode: 'split', topic })} disabled={!entries.length}><Scissors size={14} /></IconButton><IconButton title="合并主题" onClick={() => setModal({ mode: 'merge', topic })} disabled={topics.length < 2}><Merge size={14} /></IconButton></div></div>
        <h3>{topic.title}</h3>{topic.summary && <p className="topic-summary">{topic.summary}</p>}{needsReview && <span className="stale-tag">原文有修改，相关内容待重新核对</span>}{topic.manualFields?.length > 0 && <span className="manual-badge">主持人已修订</span>}
        {topic.summaryEvidenceIds?.length > 0 && <details className="topic-summary-sources"><summary>查看概述依据</summary><Evidence ids={topic.summaryEvidenceIds} onSelect={onEvidence} /></details>}
        <EntryGroups entries={readingEntries.visible} meeting={meeting} onEdit={editEntry} onEvidence={onEvidence} />
        {readingEntries.more.length > 0 && <details className="topic-more"><summary>展开其余 {readingEntries.more.length} 条</summary><EntryGroups entries={readingEntries.more} meeting={meeting} onEdit={editEntry} onEvidence={onEvidence} /></details>}
        {!entries.length && <p className="topic-no-entries">主题已建立。相关发言定稿后，整理结果会出现在这里。</p>}
        <Button className="topic-ask text-button small" onClick={() => onAskTopic(topic.id)}><Sparkles size={14} />围绕这个主题提问</Button>
      </div>}
    </div>}
    {modal?.mode === 'entry' && <EntryForm entry={modal.entry} onClose={() => setModal(null)} mutate={mutate} />}
    {modal && modal.mode !== 'entry' && <TopicForm meeting={meeting} topic={modal.topic} mode={modal.mode} onClose={() => setModal(null)} mutate={mutate} />}
  </div>;
}

export default memo(TopicPanel);
