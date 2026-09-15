import test from 'node:test';
import assert from 'node:assert/strict';
import { questionFeedback, questionProgressLabel, questionRequestKey } from '../shared/question-feedback.js';

const job = (order, status, overrides = {}) => ({ id: `answer-${order}`, type: 'answer', status, createdAt: `2026-09-09T10:00:0${order}.000Z`, input: { question: '有哪些不同意见？' }, ...overrides });

test('the latest failed question remains visible with its original input, without collecting older failures', () => {
  const latest = job(3, 'error', { error: '回答的原文引用未能核对，未保存这次回答。请重试。' });
  const jobs = [job(1, 'error'), latest, job(2, 'error', { input: { question: '决定了什么？' } })];
  const original = [...jobs];
  assert.deepEqual(questionFeedback(jobs), [latest]);
  assert.deepEqual(jobs, original);
  assert.deepEqual(questionFeedback([job(1, 'cancelled')]), [job(1, 'cancelled')]);
});

test('a new request replaces the old failure, including a retry that is still queued', () => {
  const failed = job(1, 'error');
  for (const status of ['queued', 'running', 'done']) {
    const next = job(2, status);
    assert.deepEqual(questionFeedback([failed, next]), status === 'done' ? [] : [next]);
  }
  const other = job(2, 'queued', { input: { question: '下一步做什么？' } });
  assert.deepEqual(questionFeedback([failed, other]), [other]);
});

test('unfinished requests are ordered by submission, while a late older failure cannot replace a newer answer', () => {
  const first = job(1, 'running'), second = job(2, 'queued');
  assert.deepEqual(questionFeedback([second, job(3, 'done'), first]), [first, second]);
  assert.deepEqual(questionFeedback([job(2, 'done'), job(1, 'error', { updatedAt: '2026-09-09T10:05:00.000Z' })]), []);
  assert.deepEqual(questionFeedback([job(3, 'done', { type: 'organize' }), job(2, 'error')]), [job(2, 'error')]);
});

test('a successful saved answer hides its older failure only for the same question and scope', () => {
  const failed = job(1, 'error', { input: { question: '问题', topicId: 'topic-a' } });
  const answer = { question: '问题', topicId: 'topic-a', createdAt: '2026-09-09T10:00:02.000Z' };
  assert.deepEqual(questionFeedback([failed], [answer]), []);
  assert.deepEqual(questionFeedback([failed], [{ ...answer, topicId: 'topic-b' }]), [failed]);
  assert.deepEqual(questionFeedback([failed], [{ ...answer, createdAt: '2026-09-09T10:00:00.000Z' }]), [failed]);
  assert.equal(questionRequestKey({ question: ' 问题 ', topicId: null }), questionRequestKey({ question: '问题', topicId: '' }));
});

test('question progress distinguishes queue, source review, and composing without making up percentages', () => {
  assert.equal(questionProgressLabel(job(1, 'queued')), '等待处理');
  assert.equal(questionProgressLabel(job(1, 'running')), '正在阅读会议原文');
  assert.equal(questionProgressLabel(job(1, 'running', { progress: { phase: 'select', completedBatches: 2, totalBatches: 8 } })), '正在阅读会议原文 · 2/8 段');
  assert.equal(questionProgressLabel(job(1, 'running', { progress: { phase: 'select', completedBatches: 0, totalBatches: 0 } })), '正在阅读会议原文');
  assert.equal(questionProgressLabel(job(1, 'running', { progress: { phase: 'answer', completedBatches: 8, totalBatches: 8 } })), '正在组织回答');
});
