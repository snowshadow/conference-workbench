import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkbench } from '../server/app.js';
import { createAIService } from '../server/ai/service.js';
import { createImportService } from '../server/import/service.js';
import { PROMPT_VERSION } from '../server/ai/prompts.js';

async function fixture(t,options={}) {
  const workbench=createWorkbench({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'meeting-api-test-')),...options,aiFactory:({store})=>createAIService({store,fetchImpl:async(url,opts)=>{
    const prompt=JSON.parse(JSON.parse(opts.body).messages[1].content),source=prompt.sources?.[0];
    const content=prompt.mode==='organize'?{topics:source?[{id:'new_topic',title:'交付安排',parentId:null,summary:'周五交付',entries:[{id:'new_entry',type:'decision',text:'决定周五交付',status:'active',explicitDecision:true,evidence:[{id:source.id,quote:source.text}]}]}]:[],followups:[]}:{answer:source?'决定周五交付。':'依据不足',inference:'',evidence:source?[{id:source.id,quote:source.text}]:[]};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  }})});
  workbench.server.listen(0,'127.0.0.1');await once(workbench.server,'listening');const base=`http://127.0.0.1:${workbench.server.address().port}`;
  t.after(()=>workbench.close());
  async function request(resource,method='GET',body,headers={}) {const r=await fetch(base+resource,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
  return {workbench,base,request};
}
async function until(fn){const end=Date.now()+5000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out');}

test('export distinguishes a retired focus from a resolved fact', async t => {
  const { workbench, base } = await fixture(t);
  const meeting = workbench.store.createMeeting({ title: '当前不必展开' });
  const source = workbench.store.appendTranscript(meeting.id, { text: '本次只验入口，参数在后续验证。' });
  workbench.store.mutateMeeting(meeting.id, item => {
    item.followups = [{ id: 'f1', status: 'active', question: '参数纳入哪一阶段？', impact: '后续排期', evidenceIds: [source.id],
      attention: { needed: false, reason: '本次范围已明确，参数验证有后续安排。', evidenceIds: [source.id] } }];
  });
  const exported = await (await fetch(`${base}/api/meetings/${meeting.id}/export`)).text();
  assert.match(exported, /暂不展开/);
  assert.match(exported, /本次范围已明确，参数验证有后续安排/);
  assert.doesNotMatch(exported, /尚待澄清|已解决/);
  assert.equal(workbench.store.getMeeting(meeting.id).followups[0].status, 'active');
  const later = workbench.store.appendTranscript(meeting.id, { text: '参数的具体验证安排另约时间。' });
  workbench.store.mutateMeeting(meeting.id, item => {
    item.followups[0].resolution = { outcome: 'needs_verification', complete: false, text: '本次验收范围只含入口。', author: 'ai', evidenceIds: [source.id], sourceRevision: 1 };
    item.followups[0].attention.evidenceIds = [later.id];
  });
  const withProgress = (await (await fetch(`${base}/api/meetings/${meeting.id}/export`)).text()).split('## 原始转录')[0];
  assert.match(withProgress, /已说清的部分.*本次验收范围只含入口/s);
  assert.match(withProgress, /暂不展开：本次范围已明确/);
  assert.ok(withProgress.includes(`#transcript:${later.id}`), 'retirement evidence is retained alongside partial progress');
});

test('export reformats historical AI minutes without rewriting their source, version or human replacements', async t => {
  const { workbench, base } = await fixture(t);
  const meeting = workbench.store.createMeeting({ title: '旧纪要排版' });
  const source = workbench.store.appendTranscript(meeting.id, { text: '旧观点的原文。' });
  const markdown = `## 讨论要点\n\n- **旧主题**：第一条观点 [原文](#transcript:${source.id})\n- **旧主题**：另一条观点，仍需验证。\n`;
  workbench.store.saveArtifact(meeting.id, 'minutes', { markdown, author: 'ai', sourceRevision: 1 });
  workbench.store.appendTranscript(meeting.id, { text: '后来的新发言。' });
  const before = workbench.store.getMeeting(meeting.id).artifacts.find(item => item.type === 'minutes');
  const exported = await (await fetch(`${base}/api/meetings/${meeting.id}/export`)).text();
  assert.equal(exported.match(/^### 旧主题$/gm)?.length, 1);
  assert.ok(exported.includes(`- 第一条观点 [原文](#transcript:${source.id})`));
  assert.ok(exported.includes('- 另一条观点，仍需验证。'));
  assert.deepEqual(workbench.store.getMeeting(meeting.id).artifacts.find(item => item.type === 'minutes'), before);
  for (const author of ['host', 'agent']) {
    workbench.store.saveArtifact(meeting.id, 'minutes', { markdown, author, sourceRevision: 1 });
    const authored = await (await fetch(`${base}/api/meetings/${meeting.id}/export`)).text();
    assert.ok(authored.includes(markdown));
    assert.doesNotMatch(authored, /^### 旧主题$/m);
  }
});

test('HTTP rejects foreign origins, hides secrets, isolates transcript mutations and exposes real command failures',async t=>{
  const {request}=await fixture(t);
  assert.equal((await request('/api/health','GET',null,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await request('/api/settings','PUT',{llm:{apiKey:'private-test-key'}})).data.llm.configured,true);
  assert.ok(!JSON.stringify((await request('/api/settings')).data).includes('private-test-key'));
  const fileSettings=await request('/api/settings','PUT',{fileAsr:{baseUrl:'http://127.0.0.1:8000',model:'fixture-asr',apiKey:'private-file-key',language:'zh'}});
  assert.equal(fileSettings.status,200);assert.equal(fileSettings.data.fileAsr.model,'fixture-asr');
  assert.ok(!JSON.stringify(fileSettings.data).includes('private-file-key'));
  assert.equal((await request('/api/settings','PUT',{fileAsr:{baseUrl:'file:///tmp/config'}})).status,400);
  const meeting=(await request('/api/meetings','POST',{title:'API 核验'})).data,other=(await request('/api/meetings','POST',{title:'其他会议'})).data;
  const line=(await request(`/api/meetings/${meeting.id}/transcript`,'POST',{text:'我们决定周五交付',origin:'asr',recordingId:'forged'})).data;
  assert.equal(line.origin,'host');assert.equal(line.recordingId,null);
  assert.equal((await request(`/api/meetings/${other.id}/transcript/${line.id}`,'PATCH',{text:'跨会议写入'})).status,404);
  const command=(await request(`/api/meetings/${meeting.id}/commands`,'POST',{action:'start'})).data;
  assert.equal(command.status,'error');assert.match(command.error,/页面未连接/);
  assert.notEqual((await request(`/api/meetings/${meeting.id}`)).data.capture.state,'recording');
});

test('MCP performs create -> source read -> AI question -> artifact write and HTTP readback',async t=>{
  const {base,request,workbench}=await fixture(t),client=new Client({name:'test-agent',version:'1.0'});
  await request('/api/settings','PUT',{llm:{apiKey:'fixture-only-key'}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp/server.mjs')],env:{...process.env,WORKBENCH_URL:base},stderr:'pipe'});
  await client.connect(transport);
  t.after(async()=>{await client.close();});
  async function call(name,args={}){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);}
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='control_recording'));
  const meeting=await call('create_meeting',{title:'MCP 交付讨论',goal:'确认交付时间'});
  await call('add_meeting_note',{meetingId:meeting.id,text:'我们决定周五交付。交付取决于测试环境周四准备好，目前还没有验证。',speakerId:'1'});
  const transcript=await call('get_transcript_chunk',{meetingId:meeting.id,cursor:0,limit:1});assert.equal(transcript.lines.length,1);assert.equal(transcript.nextCursor,null);
  workbench.store.mutateMeeting(meeting.id,m=>{m.followups=[{id:'delivery-assumption',kind:'assumption',question:'测试环境能否在周四准备好？',rationale:'交付依赖尚未验证的准备条件。',impact:'影响周五交付是否可行。',status:'active',author:'ai',evidenceIds:[transcript.lines[0].id],sourceRevision:1,stale:false}];});
  await call('record_clarification',{meetingId:meeting.id,followupId:'delivery-assumption',outcome:'needs_verification',text:'周五交付依赖测试环境周四准备好，这个前提仍待验证。',evidenceIds:[transcript.lines[0].id],sourceRevision:1});
  const job=await call('ask_meeting',{meetingId:meeting.id,question:'决定何时交付？'});
  const done=await until(async()=>{const j=await call('get_ai_job',{jobId:job.id});return ['done','error'].includes(j.status)?j:false;});assert.equal(done.status,'done',done.error);
  const context=await call('get_meeting_context',{meetingId:meeting.id});assert.equal(context.transcriptRevision,1);
  const clarification=context.followups.find(item=>item.id==='delivery-assumption');assert.equal(clarification.resolution.outcome,'needs_verification');assert.equal(clarification.resolution.author,'agent');assert.equal(clarification.resolution.sourceRevision,1);
  assert.equal((await call('get_transcript_chunk',{meetingId:meeting.id})).total,1,'Agent clarification is not appended as participant speech');
  const minutesJob=await call('organize_meeting',{meetingId:meeting.id,type:'minutes'});
  const minutesDone=await until(async()=>{const j=await call('get_ai_job',{jobId:minutesJob.id});return ['done','error'].includes(j.status)?j:false;});assert.equal(minutesDone.status,'done',minutesDone.error);
  const force=await call('organize_meeting',{meetingId:meeting.id,type:'organize',force:true});
  const forceDone=await until(async()=>{const j=await call('get_ai_job',{jobId:force.id});return ['done','error'].includes(j.status)?j:false;});
  assert.equal(forceDone.status,'done',forceDone.error);assert.equal(forceDone.input.force,true);assert.equal(forceDone.promptVersion,PROMPT_VERSION);assert.ok(forceDone.modelCalls.length>0);assert.equal(forceDone.sourceRevision,1);
  const generated=await call('get_artifact',{meetingId:meeting.id,type:'minutes'});assert.match(generated.markdown,/待验证/);assert.match(generated.markdown,/测试环境/);assert.match(generated.markdown,/Agent/);
  await call('save_artifact',{meetingId:meeting.id,type:'minutes',title:'交付决定',markdown:'# 交付决定\n\n决定周五交付。',sourceRevision:1});
  const artifact=await call('get_artifact',{meetingId:meeting.id,type:'minutes'});assert.equal(artifact.author,'agent');
  const readback=(await request(`/api/meetings/${meeting.id}`)).data;assert.equal(readback.artifacts[0].markdown,artifact.markdown);assert.equal(readback.questions.length,1);
});

test('MCP streams a local recording into a separate import job and reads playable transcript back through HTTP',async t=>{
  let asrCalls=0;
  const {base,request,workbench}=await fixture(t,{importFactory:({store,ai})=>createImportService({store,ai,
    decode:async({outputPath})=>fs.writeFileSync(outputPath,Buffer.alloc(6400)),
    fetchImpl:async(url,options)=>{asrCalls++;assert.match(url,/auc\/bigmodel\/recognize\/flash$/);assert.equal(new Headers(options.headers).get('X-Api-Key'),'file-test-key');return Response.json({result:{text:'先核对实时的含义，再决定连接方式。'}},{headers:{'X-Api-Status-Code':'20000000'}});},
  })});
  await request('/api/settings','PUT',{asr:{apiKey:'file-test-key'}});
  const filePath=path.join(workbench.store.dataDir,'local-fixture.wav');fs.writeFileSync(filePath,Buffer.from('fixture-file-decoded-by-test-seam'));
  const client=new Client({name:'import-test-agent',version:'1.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp/server.mjs')],env:{...process.env,WORKBENCH_URL:base},stderr:'pipe'}));
  t.after(()=>client.close());
  async function call(name,args){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);}
  const imported=await call('import_recording',{filePath,title:'录音导入核验',goal:'对齐实时含义'});
  assert.equal(imported.meeting.status,'ended');assert.equal(imported.meeting.source,'recording_import');assert.equal(imported.job.type,'import');
  const done=await until(async()=>{const j=await call('get_ai_job',{jobId:imported.job.id});return ['done','error'].includes(j.status)?j:false;});
  assert.equal(done.status,'done',done.error);assert.equal(done.result.transcriptCount,1);assert.equal(done.result.analysisState,'not_configured');
  const context=await call('get_meeting_context',{meetingId:imported.meeting.id});assert.equal(context.source,'recording_import');assert.equal(context.importJobId,done.id);assert.notEqual(context.capture.state,'recording');assert.equal(context.jobs[0].progress.phase,'done');
  const transcript=await call('get_transcript_chunk',{meetingId:imported.meeting.id});
  assert.equal(transcript.lines[0].origin,'asr');assert.equal(transcript.lines[0].timing,'chunk');assert.equal(transcript.lines[0].endSample,3200);
  const audio=await fetch(`${base}/api/recordings/${done.result.recordingId}/audio?startSample=1600&endSample=3200`);
  assert.equal(audio.status,200);const bytes=Buffer.from(await audio.arrayBuffer());assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.length,44+3200);
  assert.equal((await call('retry_recording_import',{meetingId:imported.meeting.id})).id,done.id);assert.equal(asrCalls,1);
  assert.equal((await request('/api/meetings')).data.meetings.length,1);
});

test('MCP context follows the same focus after a host ignores it, while explicit quiet stays quiet', async t => {
  const { base, request, workbench } = await fixture(t);
  const meeting = workbench.store.createMeeting({ title: '焦点接口一致性' });
  workbench.store.mutateMeeting(meeting.id, draft => {
    draft.focusFollowupId = 'current';
    draft.followups = [
      { id: 'current', topicId: 'delivery', question: '范围是否已确定？', status: 'active', author: 'ai' },
      { id: 'stale', topicId: 'delivery', question: '此前的排期是否有效？', status: 'active', stale: true, author: 'ai' },
      { id: 'unrelated', topicId: 'cost', question: '谁来核对成本？', status: 'active', author: 'ai' },
      { id: 'next', topicId: 'delivery', question: '谁来确认交付条件？', status: 'active', author: 'ai' },
    ];
  });
  const client = new Client({ name: 'focus-test-agent', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/server.mjs')], env: { ...process.env, WORKBENCH_URL: base }, stderr: 'pipe' }));
  t.after(() => client.close());
  async function context() {
    const result = await client.callTool({ name: 'get_meeting_context', arguments: { meetingId: meeting.id } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }
  assert.equal((await context()).focusFollowupId, 'current');
  const ignored = await request(`/api/meetings/${meeting.id}/followups/current`, 'PATCH', { status: 'ignored', author: 'host' });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.data.focusFollowupId, 'next', 'dismissing explicitly advances focus without a model call');
  const next = await context();
  assert.equal(next.focusFollowupId, 'next', 'MCP advances to the same valid related question as the page');
  assert.equal(next.followups.some(item => item.id === 'current'), false);
  assert.equal(workbench.store.getMeeting(meeting.id).focusFollowupId, 'next', 'context preserves the focus saved by the host action');
  assert.equal(workbench.store.listJobs(meeting.id).length, 0);
  workbench.store.mutateMeeting(meeting.id, draft => { draft.focusFollowupId = null; });
  const quiet = await context();
  assert.equal(quiet.focusFollowupId, null);
  assert.ok(quiet.followups.some(item => item.id === 'next' && item.status === 'active'), 'an explicit quiet recommendation does not consume or promote the queue');
  const manualIgnore = await request(`/api/meetings/${meeting.id}/followups/next`, 'PATCH', { status: 'ignored', author: 'host' });
  assert.equal(manualIgnore.data.focusFollowupId, 'unrelated', 'explicit dismissal advances from a manually selected question while AI was quiet');
  assert.equal((await context()).focusFollowupId, 'unrelated');
});

test('export identifies historical minutes after transcript changes instead of declaring stale decisions current',async t=>{
  const {base,request}=await fixture(t),m=(await request('/api/meetings','POST',{title:'导出修正'})).data;
  const line=(await request(`/api/meetings/${m.id}/transcript`,'POST',{text:'我们决定 A'})).data;
  await request(`/api/meetings/${m.id}/artifacts/minutes`,'PUT',{markdown:'# 决定\n\n采用 A',sourceRevision:1});
  await request(`/api/meetings/${m.id}/transcript/${line.id}`,'PATCH',{text:'我们决定 B'});
  const exported=await(await fetch(`${base}/api/meetings/${m.id}/export`)).text();assert.match(exported,/历史草稿/);assert.match(exported,/版本 1/);assert.match(exported,/版本 2/);assert.match(exported,/我们决定 B/);
});
