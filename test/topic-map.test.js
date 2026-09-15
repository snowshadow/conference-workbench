import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopicMap } from '../src/lib/topic-map.js';

const topics = [
  { id: 'memory', title: '记忆架构', entries: [] },
  { id: 'context', title: '会话上下文', parentId: 'memory', entries: [] },
  { id: 'runtime', title: '运行时', entries: [] },
  { id: 'protocol', title: '交互协议', entries: [] },
  { id: 'release', title: '上线安排', entries: [] },
];
const build = (extra = {}) => buildTopicMap({ topics, meetingTitle: '0909 技术例会', selected: 'context', folded: new Set(), onFold() {}, ...extra });

test('meeting root connects the four top-level topics while preserving the real child relationship', () => {
  const before = structuredClone(topics);
  const graph = build();
  const root = graph.nodes.find(node => node.type === 'meeting');
  assert.equal(root.data.title, '0909 技术例会');
  assert.equal(root.selectable, false);
  assert.equal(root.focusable, false);
  assert.equal(root.data.id, undefined);
  assert.equal(graph.nodes.length, 6);
  assert.deepEqual(graph.edges.filter(edge => edge.source === root.id).map(edge => edge.target), ['memory', 'runtime', 'protocol', 'release']);
  assert.equal(graph.edges.find(edge => edge.target === 'context').source, 'memory');
  assert.ok(graph.edges.every(edge => edge.type === 'default' && !edge.markerEnd));
  assert.deepEqual(topics, before);
  for (const node of graph.nodes) {
    assert.equal(node.width, node.style.width);
    assert.equal(node.height, node.style.height);
    assert.ok(Number.isFinite(node.position.x) && Number.isFinite(node.position.y));
  }
  for (const edge of graph.edges) {
    const source = graph.nodes.find(node => node.id === edge.source);
    const target = graph.nodes.find(node => node.id === edge.target);
    assert.ok(source.position.x + source.width < target.position.x);
  }
});

test('folding keeps the parent and sibling roots, and unfolding restores the selected child', () => {
  const folded = new Set(['memory']);
  const graph = build({ folded });
  assert.equal(graph.nodes.some(node => node.id === 'context'), false);
  assert.equal(graph.nodes.filter(node => node.type === 'topic').length, 4);
  assert.equal(graph.edges.length, 4);
  const parent = graph.nodes.find(node => node.id === 'memory');
  assert.equal(parent.data.folded, true);
  assert.equal(parent.data.childCount, 1);
  assert.equal(parent.selected, false);
  assert.deepEqual([...folded], ['memory']);
  const restored = build();
  assert.equal(restored.nodes.find(node => node.id === 'context').selected, true);
});
