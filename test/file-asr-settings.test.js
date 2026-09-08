import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

function fixture(t) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(FILE_ASR_|OMLX_|VOLCENGINE_ASR_)/.test(key)));
  for (const key of Object.keys(env)) delete process.env[key];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-file-settings-')));
  t.after(() => { store.close(); Object.assign(process.env, env); });
  return store;
}

test('new installs default to Volcengine and use speech credentials without returning secrets', t => {
  const store = fixture(t);
  assert.equal(store.getSettings().fileAsr.provider, 'volcengine');
  assert.equal(store.publicSettings().fileAsr.configured, false);
  store.saveSettings({ asr: { apiKey: 'speech-test-secret' } });
  const settings = store.publicSettings();
  assert.equal(settings.fileAsr.provider, 'volcengine');
  assert.equal(settings.fileAsr.resourceId, 'volc.bigasr.auc_turbo');
  assert.equal(settings.fileAsr.configured, true);
  assert.doesNotMatch(JSON.stringify(settings), /speech-test-secret/);
});

test('legacy settings stay OpenAI-compatible until switched, and switching keeps its separate credentials', t => {
  const store = fixture(t);
  store.db.prepare('INSERT INTO settings(id,data) VALUES(1,?)').run(JSON.stringify({ fileAsr: { baseUrl: 'https://example.invalid/v1', model: 'existing-model', apiKey: 'old-file-secret' } }));
  assert.equal(store.getSettings().fileAsr.provider, 'openai');
  assert.equal(store.publicSettings().fileAsr.configured, true);
  store.saveSettings({ fileAsr: { provider: 'volcengine' } });
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
