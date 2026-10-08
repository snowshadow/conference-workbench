import { EmptyState, Evidence } from './ui.jsx';
import { awaitingSpeakers } from '../../shared/meeting-scenarios.js';
import './ActionItems.css';

export default function ActionItems({ meeting, onEvidence }) {
  const actions = (meeting.topics || []).filter(topic => !topic.mergedInto).flatMap(topic => (topic.entries || []).filter(entry => entry.type === 'action' && !['superseded', 'resolved'].includes(entry.status)).map(entry => ({ ...entry, topicTitle: topic.title })));
  return <div className="action-items"><p className="action-items-intro">核对要做什么、由谁负责、何时完成。未在会上明确的信息留待补充。</p>
    {actions.length ? actions.map(entry => <article className={`action-item ${entry.stale ? 'is-stale' : ''}`} key={entry.id}><span>{entry.topicTitle}</span><h3>{entry.text}</h3><dl><div><dt>负责人</dt><dd>{entry.owner || '待明确'}</dd></div><div><dt>时间</dt><dd>{entry.due || '待明确'}</dd></div></dl>{entry.stale && <p role="status">原文已修改，此项待重新核对。</p>}<Evidence ids={entry.evidenceIds} onSelect={onEvidence} /></article>) : <EmptyState title={awaitingSpeakers(meeting) ? '先确认说话人' : meeting.processedRevision ? '暂无有原文依据的 TODO' : '等待整理 TODO'}>{awaitingSpeakers(meeting) ? '转录完成后核对说话人，确认后生成纪要。' : '分析会保留会上明确提出的任务，不补写未约定的责任或日期。'}</EmptyState>}
  </div>;
}
