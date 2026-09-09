import dagre from '@dagrejs/dagre';
import { isCurrentEntry } from '../../shared/discussion-view.js';

const nodeSize = { width: 205, height: 88 };

export function buildTopicMap({ topics, meetingTitle, selected, folded, onFold }) {
  const byId = new Map(topics.map(topic => [topic.id, topic]));
  let rootId = 'meeting-map-root';
  while (byId.has(rootId)) rootId = `_${rootId}`;
  const visible = topics.filter(topic => {
    let cursor = topic;
    const visited = new Set();
    while (cursor?.parentId && byId.has(cursor.parentId) && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (folded.has(cursor.parentId)) return false;
      cursor = byId.get(cursor.parentId);
    }
    return true;
  });
  const visibleIds = new Set(visible.map(topic => topic.id));
  const nodes = [
    { id: rootId, type: 'meeting', selectable: false, focusable: false, data: { title: meetingTitle } },
    ...visible.map(topic => ({
      id: topic.id, type: 'topic', selected: topic.id === selected,
      data: {
        id: topic.id, title: topic.title,
        entryCount: topic.entries?.filter(isCurrentEntry).length || 0,
        childCount: topics.filter(item => item.parentId === topic.id).length,
        folded: folded.has(topic.id), onFold,
      },
    })),
  ];
  const edges = visible.map(topic => ({
    id: `topic-map-edge-${topic.id}`,
    source: visibleIds.has(topic.parentId) ? topic.parentId : rootId,
    target: topic.id,
    type: 'default',
    style: { stroke: 'var(--map-edge)', strokeWidth: 1.5 },
  }));
  const dag = new dagre.graphlib.Graph();
  dag.setGraph({ rankdir: 'LR', ranksep: 60, nodesep: 26, marginx: 20, marginy: 20 });
  dag.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) dag.setNode(node.id, { ...nodeSize });
  for (const edge of edges) dag.setEdge(edge.source, edge.target);
  dagre.layout(dag);
  return {
    nodes: nodes.map(node => ({
      ...node, ...nodeSize, style: { ...nodeSize },
      position: { x: dag.node(node.id).x - nodeSize.width / 2, y: dag.node(node.id).y - nodeSize.height / 2 },
    })),
    edges,
  };
}
