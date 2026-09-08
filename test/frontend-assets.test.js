import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createWorkbench } from '../server/app.js';

test('frontend revalidates its HTML and never serves HTML for a missing lazy-loaded asset',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'meeting-frontend-test-'));
  const distDir=path.join(directory,'dist');
  mkdirSync(path.join(distDir,'assets'),{recursive:true});
  const html='<!doctype html><html><body>meeting fixture</body></html>';
  const javascript='export const fixture = true;';
  writeFileSync(path.join(distDir,'index.html'),html);
  writeFileSync(path.join(distDir,'assets','TopicPanel-existing.js'),javascript);
  const workbench=createWorkbench({dataDir:path.join(directory,'data'),distDir});
  workbench.server.listen(0,'127.0.0.1');
  await once(workbench.server,'listening');
  t.after(()=>workbench.close());
  const base=`http://127.0.0.1:${workbench.server.address().port}`;

  for(const route of ['/','/index.html','/meeting/example']) {
    const response=await fetch(base+route);
    assert.equal(response.status,200,route);
    assert.equal(response.headers.get('cache-control'),'no-cache',route);
    assert.equal(await response.text(),html,route);
  }
  const existing=await fetch(`${base}/assets/TopicPanel-existing.js`);
  assert.equal(existing.status,200);
  assert.match(existing.headers.get('content-type'),/javascript/);
  assert.equal(await existing.text(),javascript);

  const missing=await fetch(`${base}/assets/TopicPanel-removed.js`);
  assert.equal(missing.status,404);
  assert.doesNotMatch(missing.headers.get('content-type'),/text\/html/);
  assert.equal((await missing.json()).error,'前端资源不存在，请刷新页面');
  assert.equal((await fetch(`${base}/api/missing`)).status,404);
});
