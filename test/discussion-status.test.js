import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDiscussionJob, needsManualAnalysis } from '../shared/discussion-status.js';

const meeting = (overrides = {}) => ({
  status: 'active', archived: false, autoOrganize: false, capture: { state: 'idle' },
  transcriptRevision: 8, processedRevision: 5, topics: [], jobs: [], ...overrides,
});
const visible = (value = meeting(), options = {}) => needsManualAnalysis(value, { configured: true, ...options });
const job = (type, status, order = 1) => ({ id: `${type}-${order}`, type, status, createdAt: `2026-09-09T10:00:0${order}.000Z` });

test('manual analysis needs actual unprocessed or corrected source content', () => {
  assert.equal(visible(), true);
  assert.equal(visible(null), false);
  assert.equal(visible(meeting({ transcriptRevision: 0, processedRevision: 0 })), false);
  assert.equal(visible(meeting({ processedRevision: 8 })), false);
  assert.equal(visible(meeting({ processedRevision: 8, topics: [{ stale: false }] })), false);
  assert.equal(visible(meeting({ processedRevision: 8, topics: [{ stale: true }] })), true);
  assert.equal(visible(meeting({ processedRevision: 0 })), true, 'editing an old transcript resets its processed revision');
});

test('normal automatic recording stays quiet while paused or stopped capture can be analyzed manually', () => {
  const automatic = meeting({ autoOrganize: true, capture: { state: 'recording' } });
  assert.equal(visible(automatic), false);
  assert.equal(visible(automatic, { captureState: 'paused' }), true);
  assert.equal(visible(automatic, { captureState: 'idle' }), true);
  assert.equal(visible({ ...automatic, capture: { state: 'paused' } }), true);
  assert.equal(visible({ ...automatic, autoOrganize: false }), true);
  assert.equal(visible({ ...automatic, status: 'ended' }), true, 'an ended meeting cannot rely on the live scheduler');
  assert.equal(visible({ ...automatic, processedRevision: 8, topics: [{ stale: true }] }), true, 'the scheduler skips equal transcript versions even when topics are stale');
  assert.equal(visible({ ...automatic, topics: [{ stale: true }] }), false, 'new transcript content will still trigger automatic analysis');
});

test('archived, unconfigured, and changing capture states do not offer manual analysis', () => {
  assert.equal(visible(meeting({ archived: true })), false);
  assert.equal(needsManualAnalysis(meeting()), false);
  assert.equal(visible(meeting(), { configured: false }), false);
  assert.equal(visible(meeting(), { capturePending: true }), false);
});

test('submitting requests and source-processing jobs avoid duplicate actions', () => {
  for (const status of ['submitting', 'queued', 'running']) {
    assert.equal(visible(meeting(), { request: job('organize', status) }), false, status);
  }
  for (const type of ['import', 'organize', 'followup', 'minutes']) {
    for (const status of ['queued', 'running']) {
      assert.equal(visible(meeting({ jobs: [job(type, status)] })), false, `${type} ${status}`);
    }
  }
  assert.equal(visible(meeting({ jobs: [job('answer', 'running')] })), true, 'a meeting answer does not consume pending organization');
});

test('latest failed or cancelled analysis uses the existing retry action', () => {
  for (const type of ['organize', 'followup', 'minutes']) {
    for (const status of ['error', 'cancelled']) {
      assert.equal(visible(meeting({ jobs: [job(type, status)] })), false, `${type} ${status}`);
    }
  }
  for (const status of ['error', 'cancelled']) {
    assert.equal(visible(meeting({ jobs: [job('organize', 'done')] }), { request: job('organize', status, 2) }), false);
  }
});

test('new successful analysis supersedes historical failures without hiding later pending content', () => {
  for (const status of ['error', 'cancelled']) {
    const jobs = [job('organize', 'done', 3), job('minutes', status, 1), job('followup', status, 2)];
    assert.equal(visible(meeting({ jobs })), true);
    assert.equal(visible(meeting({ jobs, processedRevision: 8 })), false);
  }
});

test('unfinished imports remain on the import recovery path until a later import succeeds', () => {
  for (const status of ['error', 'cancelled']) {
    const failedImport = job('import', status, 1);
    assert.equal(visible(meeting({ jobs: [failedImport] })), false);
    assert.equal(visible(meeting({ jobs: [job('organize', 'done', 2), failedImport] })), false);
    assert.equal(visible(meeting({ jobs: [job('import', 'done', 2), failedImport] })), true);
  }
});

test('discussion status keeps active job priority and ignores unrelated work without mutating input', () => {
  const running = job('organize', 'running', 1);
  const queued = job('minutes', 'queued', 2);
  const done = job('followup', 'done', 3);
  const jobs = [job('import', 'running', 4), done, queued, running, job('answer', 'error', 5)];
  const original = [...jobs];
  assert.equal(latestDiscussionJob(jobs), running);
  assert.equal(latestDiscussionJob(jobs.filter(value => value !== running)), queued);
  assert.equal(latestDiscussionJob(jobs.filter(value => value !== running && value !== queued)), done);
  assert.equal(latestDiscussionJob([job('import', 'done')]), null);
  assert.equal(latestDiscussionJob(), null);
  assert.deepEqual(jobs, original);
});
