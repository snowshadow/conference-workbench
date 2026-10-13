import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

function fixture(t) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(FILE_ASR_|OMLX_|VOLCENGINE_ASR_|TOS_)/.test(key)));
  for (const key of Object.keys(env)) delete process.env[key];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-file-settings-')));
  t.after(() => {
    store.close();
    for (const key of Object.keys(process.env)) if (/^(FILE_ASR_|OMLX_|VOLCENGINE_ASR_|TOS_)/.test(key)) delete process.env[key];
    Object.assign(process.env, env);
  });
  return store;
}

test('new installs use Doubao 2.0 and require storage for file transcription', t => {
  const store = fixture(t);
  assert.equal(store.getSettings().fileAsr.provider, 'volcengine');
  assert.equal(store.publicSettings().fileAsr.configured, false);
  store.saveSettings({ asr: { apiKey: 'speech-test-secret' } });
  const settings = store.publicSettings();
  assert.equal(settings.asr.resourceId, 'volc.seedasr.sauc.duration');
  assert.equal(settings.fileAsr.provider, 'volcengine');
  assert.equal(settings.fileAsr.resourceId, 'volc.seedasr.auc');
  assert.equal(settings.fileAsr.configured, false);
  store.saveSettings({ tos: { bucket: 'test-bucket', accessKeyId: 'storage-id-secret', accessKeySecret: 'storage-test-secret' } });
  assert.equal(store.publicSettings().fileAsr.configured, true);
  assert.doesNotMatch(JSON.stringify(store.publicSettings()), /storage-id-secret|storage-test-secret/);
  store.saveSettings({ tos: { accessKeyId: '', accessKeySecret: '' } });
  assert.equal(store.getSettings().tos.accessKeySecret, 'storage-test-secret');
  assert.throws(() => store.saveSettings({ tos: { bucket: 'bucket/path' } }), /格式无效/);
  assert.doesNotMatch(JSON.stringify(settings), /speech-test-secret/);
});

test('saved and environment realtime resources stay explicit, and switching accounts preserves file settings', t => {
  const store = fixture(t);
  process.env.VOLCENGINE_ASR_RESOURCE_ID = 'volc.seedasr.sauc.concurrent';
  assert.equal(store.getSettings().asr.resourceId, 'volc.seedasr.sauc.concurrent');
  store.saveSettings({ asr: { resourceId: 'volc.bigasr.sauc.duration', apiKey: 'old-test-key' } });
  assert.equal(store.getSettings().asr.resourceId, 'volc.bigasr.sauc.duration');
  const previousFile = store.getSettings().fileAsr;
  store.saveSettings({ asr: { resourceId: 'volc.seedasr.sauc.duration', apiKey: 'new-test-key' } });
  assert.equal(store.getSettings().asr.resourceId, 'volc.seedasr.sauc.duration');
  assert.equal(store.getSettings().asr.apiKey, 'new-test-key');
  assert.deepEqual(store.getSettings().fileAsr, previousFile);
  assert.doesNotMatch(JSON.stringify(store.publicSettings()), /old-test-key|new-test-key/);
});

test('legacy settings stay OpenAI-compatible until switched, and switching keeps its separate credentials', t => {
  const store = fixture(t);
  store.db.prepare('INSERT INTO settings(id,data) VALUES(1,?)').run(JSON.stringify({ fileAsr: { baseUrl: 'https://example.invalid/v1', model: 'existing-model', apiKey: 'old-file-secret' } }));
  assert.equal(store.getSettings().fileAsr.provider, 'openai');
  assert.equal(store.publicSettings().fileAsr.configured, true);
  store.saveSettings({ fileAsr: { provider: 'volcengine', resourceId: 'volc.bigasr.auc_turbo' } });
  assert.equal(store.publicSettings().fileAsr.configured, false, 'an OpenAI key does not authenticate Volcengine');
  store.saveSettings({ asr: { appKey: 'app-key', accessKey: 'access-key' } });
  assert.equal(store.publicSettings().fileAsr.configured, true);
  store.saveSettings({ fileAsr: { provider: 'openai' } });
  assert.equal(store.getSettings().fileAsr.apiKey, 'old-file-secret');
  assert.equal(store.getSettings().fileAsr.model, 'existing-model');
});

test('legacy API clients select OpenAI through an explicit URL/model and invalid providers are rejected', t => {
  const store = fixture(t);
  store.saveSettings({ fileAsr: { baseUrl: 'http://127.0.0.1:8000', model: 'local-model' } });
  assert.equal(store.publicSettings().fileAsr.provider, 'openai');
  assert.throws(() => store.saveSettings({ fileAsr: { provider: 'unknown' } }), /请选择/);
  assert.equal(store.publicSettings().fileAsr.provider, 'openai');
});
