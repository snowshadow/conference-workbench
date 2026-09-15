import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, fail } from './store.js';
import { addTopic,editTopic,mergeTopic,editEntry,editFollowup } from './content.js';
import { createAIService } from './ai/service.js';
import { createCaptureService } from './capture/service.js';
import { createImportService } from './import/service.js';
import { minutesDocumentMarkdown } from '../shared/minutes-format.js';
import { resolutionOutcomes } from '../shared/resolution-copy.js';
import { presentMeetingPeople, presentPeopleValue, speakerName } from '../shared/people.js';
import { createVoiceprintService } from './voiceprints/service.js';
import { createAutomaticSpeakerService } from './voiceprints/automatic.js';
import { registerPeopleRoutes } from './people-routes.js';
import { ensureParticipant, resolveParticipant } from './people/store.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const asyncRoute=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
const jsonObject=(req,res,next)=>{if(req.body && (Array.isArray(req.body) || typeof req.body!=='object')) return next(fail('请求内容必须为对象'));next();};
export function createWorkbench({dataDir=process.env.WORKBENCH_DATA_DIR || path.join(root,'data'),distDir=path.join(root,'dist'),aiFactory=createAIService,captureFactory=createCaptureService,importFactory=createImportService,voiceprintFactory=createVoiceprintService,automaticFactory=createAutomaticSpeakerService}={}) {
  const store=new Store(dataDir),app=express(),server=http.createServer(app);
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const host=req.headers.host || '';
    if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return next(fail('仅支持本机访问',403));
    const origin=req.headers.origin;
    if(origin) {
      let parsed;try{parsed=new URL(origin);}catch{return next(fail('请求来源无效',403));}
      const ports=new Set(['5187',String(process.env.PORT || 8797),String(server.address()?.port || '')]);
      if(!['http:','https:'].includes(parsed.protocol) || !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || !ports.has(parsed.port)) return next(fail('不允许此网页来源访问',403));
    }
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    if(req.path.startsWith('/api/')) res.setHeader('Cache-Control','no-store');
    next();
  });
  app.use(express.json({limit:'2mb'}),jsonObject);
  const ai=aiFactory({store});
  const voiceprints=voiceprintFactory({store});
  const automatic=automaticFactory({store,voiceprints,ai});
  const onTranscript=meetingId=>automatic.notify(meetingId);
  const imports=importFactory({store,ai,onTranscript});
  const capture=captureFactory({server,store,onTranscript,onEnded:meetingId=>{
    store.updateMeeting(meetingId,{status:'ended',endedAt:new Date().toISOString()});
    if(store.allTranscript(meetingId).length) ai.submit(meetingId,'minutes');
  }});
  const detail=meetingId=>{const meeting=store.getMeeting(meetingId);return {...presentMeetingPeople(meeting),capture:capture.getState(meetingId),recordings:store.listRecordings(meetingId),jobs:store.listJobs(meetingId).slice(0,30).map(job=>presentPeopleValue(job,meeting)),commands:store.listCommands(meetingId).slice(0,10)};};
  const {refresh:refreshSpeakers}=registerPeopleRoutes({app,store,ai,voiceprints,automatic,detail});
  app.get('/api/health',(req,res)=>res.json({ok:true,name:'conference-workbench',version:'0.1.2'}));
  app.get('/api/settings',(req,res)=>res.json(store.publicSettings()));
  app.put('/api/settings',(req,res)=>res.json(store.saveSettings(req.body)));
  app.get('/api/meetings',(req,res)=>res.json(req.query.limit !== undefined || req.query.cursor !== undefined
    ? store.listMeetingsPage({archived:req.query.archived==='1',limit:req.query.limit ?? 20,cursor:req.query.cursor})
    : {meetings:store.listMeetings({archived:req.query.archived==='1'}).map(m=>({id:m.id,title:m.title,goal:m.goal,status:m.status,archived:m.archived,createdAt:m.createdAt,updatedAt:m.updatedAt,transcriptRevision:m.transcriptRevision,topicCount:m.topics.filter(t=>!t.mergedInto).length}))}));
  app.post('/api/meetings',(req,res)=>res.status(201).json(store.createMeeting(req.body)));
  app.post('/api/meetings/import',asyncRoute(async(req,res)=>res.status(202).json(await imports.receive(req))));
  app.post('/api/meetings/:id/import/retry',(req,res)=>res.status(202).json(imports.retry(req.params.id)));
  app.get('/api/meetings/:id',(req,res)=>res.json(detail(req.params.id)));
  app.patch('/api/meetings/:id',(req,res)=>{
    const previous=store.getMeeting(req.params.id);
    const input={};
    for(const key of ['title','goal','archived','autoOrganize','speakerLabels']) if(Object.hasOwn(req.body,key)) input[key]=req.body[key];
    for(const key of ['archived','autoOrganize']) if(Object.hasOwn(input,key) && typeof input[key]!=='boolean') throw fail(`${key} 必须为布尔值`);
    if(input.speakerLabels && (typeof input.speakerLabels!=='object' || Array.isArray(input.speakerLabels) || Object.values(input.speakerLabels).some(v=>typeof v!=='string'))) throw fail('说话人名称格式无效');
    if(input.archived && ['recording','paused'].includes(capture.getState(req.params.id).state)) throw fail('请先停止录音再归档',409);
    const updated=store.updateMeeting(req.params.id,input);
    let refreshJob=null;
    if(Object.hasOwn(input,'speakerLabels')) {
      const changedPeople=new Set(updated.participants.filter(person=>person.name!==previous.participants.find(before=>before.id===person.id)?.name).map(person=>resolveParticipant(updated,person.id)?.id));
      const sources=store.allTranscript(req.params.id).filter(line=>changedPeople.has(line.participantId)).map(line=>line.id);
      refreshJob=refreshSpeakers(req.params.id,sources,'labels');
    }
    res.json({...detail(req.params.id),...(refreshJob?{refreshJob}:{})});
  });
  app.get('/api/meetings/:id/transcript',(req,res)=>res.json(store.getTranscript(req.params.id,req.query)));
  app.post('/api/meetings/:id/transcript',(req,res)=>res.status(201).json(store.appendTranscript(req.params.id,{...req.body,id:undefined,recordingId:null,startSample:null,endSample:null,origin:req.body.author==='agent'?'agent':'host'})));
  app.patch('/api/meetings/:id/transcript/:lineId',(req,res)=>{
    const previous=store.allTranscript(req.params.id).find(line=>line.id===req.params.lineId);
    if(!previous) throw fail('转录片段不存在',404);
    const patch={origin:req.body.author==='agent'?'agent':'host'};
    for(const key of ['text','speakerId']) if(Object.hasOwn(req.body,key)) patch[key]=req.body[key];
    const textChanged=Object.hasOwn(patch,'text') && String(patch.text ?? '').trim().slice(0,20000)!==previous.text;
    if(Object.hasOwn(patch,'speakerId') && !textChanged) {
      if(typeof patch.speakerId!=='string' || patch.speakerId.trim().length>100) throw fail('说话人标识无效');
      const result=(()=>{
        const meeting=store.getMeeting(req.params.id),speakerId=patch.speakerId.trim();
        // Old raw numbers can repeat between recordings. Prefer the same
        // recording, and require an explicit participant when still ambiguous.
        let candidates=meeting.participants.filter(person=>speakerId && !['unknown','未知'].includes(speakerId) && person.speakerIds?.includes(speakerId));
        const sameRecording=candidates.filter(person=>person.legacyRecordingId===undefined || person.legacyRecordingId===(previous.recordingId || null));
        if(sameRecording.length) candidates=sameRecording;
        const ids=[...new Set(candidates.map(person=>resolveParticipant(meeting,person.id)?.id).filter(Boolean))];
        if(ids.length>1) throw fail('这个说话人编号对应多位参会者，请在说话人列表中选择具体的人',409);
        let participantId=ids[0];
        if(!participantId) {
          const participant=ensureParticipant(meeting,{id:`legacy-identity:${previous.id}`,speakerId,recordingId:previous.recordingId});
          participantId=participant.id;store.persistMeeting(meeting);
        }
        return store.assignTranscriptParticipant(req.params.id,previous.id,participantId,{author:patch.origin});
      })();
      const refreshJob=refreshSpeakers(req.params.id,result.affectedSourceIds,'attribution');
      return res.json({...store.allTranscript(req.params.id).find(line=>line.id===previous.id),...(refreshJob?{refreshJob}:{})});
    }
    res.json(store.editTranscript(req.params.id,req.params.lineId,patch));
  });
  app.post('/api/meetings/:id/topics',(req,res)=>res.status(201).json(addTopic(store,req.params.id,req.body)));
  app.patch('/api/meetings/:id/topics/:topicId',(req,res)=>res.json(editTopic(store,req.params.id,req.params.topicId,req.body)));
  app.post('/api/meetings/:id/topics/:topicId/merge',(req,res)=>res.json(mergeTopic(store,req.params.id,req.params.topicId,req.body.targetId)));
  app.patch('/api/meetings/:id/entries/:entryId',(req,res)=>res.json(editEntry(store,req.params.id,req.params.entryId,req.body)));
  app.patch('/api/meetings/:id/followups/:followupId',(req,res)=>res.json(editFollowup(store,req.params.id,req.params.followupId,req.body)));
  app.post('/api/meetings/:id/jobs',(req,res)=>res.status(202).json(ai.submit(req.params.id,req.body.type,{question:req.body.question,topicId:req.body.topicId,force:req.body.force})));
  app.get('/api/jobs/:id',(req,res)=>{const job=store.getJob(req.params.id);res.json(presentPeopleValue(job,store.getMeeting(job.meetingId)));});
  app.post('/api/meetings/:id/commands',asyncRoute(async(req,res)=>res.status(202).json(await capture.request(req.params.id,req.body.action))));
  app.get('/api/commands/:id',(req,res)=>res.json(store.getCommand(req.params.id)));
  app.put('/api/meetings/:id/artifacts/:type',(req,res)=>{
    if(!/^[a-z][a-z0-9-]{0,60}$/.test(req.params.type)) throw fail('产物类型无效');
    if(typeof req.body.markdown!=='string') throw fail('产物内容必须为 Markdown 文本');
    if(req.body.sourceRevision!==undefined && (!Number.isInteger(req.body.sourceRevision) || req.body.sourceRevision<0 || req.body.sourceRevision>store.getMeeting(req.params.id).transcriptRevision)) throw fail('来源版本无效');
    res.json(store.saveArtifact(req.params.id,req.params.type,{...req.body,author:req.body.author==='agent'?'agent':'host'}));
  });
  app.get('/api/meetings/:id/export',(req,res)=>{
    const m=presentMeetingPeople(store.getMeeting(req.params.id)),lines=store.allTranscript(m.id),minutes=m.artifacts.find(a=>a.type==='minutes');
    const clarifications=m.followups.filter(f=>f.status!=='ignored' && !f.mergedInto && !f.stale && !f.resolution?.stale).map(f=>{
      const r=f.resolution;
      const ids=r?.evidenceIds || f.evidenceIds || [];
      const references=ids.map(id=>`[原文](#transcript:${encodeURIComponent(id)})`).join(' ');
      const retired=f.status==='active' && f.attention?.needed===false;
      const attentionReferences=(f.attention?.evidenceIds || []).map(id=>`[原文](#transcript:${encodeURIComponent(id)})`).join(' ');
      const progress=r ? `- **${r.complete===false?'已说清的部分':r.outcome==='recorded'?'讨论记录':resolutionOutcomes[r.outcome]?.label || '讨论记录'}**：${r.text}（${r.author==='ai'?'AI 整理':r.author==='agent'?'Agent 记录':'主持人记录'}；依据转录版本 ${r.sourceRevision}${ids.length?'':'；未关联原文'}） ${references}` : f.status==='active' ? `- **${retired?'暂不展开':'尚待澄清'}**：${f.question}${!retired&&f.impact?`\n  可能影响：${f.impact}`:''} ${references}` : '';
      return `${progress}${retired?`\n  暂不展开：${f.attention.reason} ${attentionReferences}`:''}`;
    }).filter(Boolean);
    const content=minutesDocumentMarkdown(minutes) || `# ${m.title}\n\n${m.goal?`讨论目标（不作为会议事实）：${m.goal}\n\n`:''}${clarifications.length?`## 澄清进展\n\n${clarifications.join('\n\n')}\n\n`:''}${m.topics.filter(t=>!t.mergedInto).map(t=>`## ${t.title}\n\n${t.stale?'主题摘要等待重新整理。':t.summary || ''}\n\n${t.entries.filter(e=>e.status!=='superseded'&&!e.stale).map(e=>`- ${e.text}`).join('\n')}`).join('\n\n')}`;
    const revisionNote=minutes?.stale?`> 以下纪要基于转录版本 ${minutes.sourceRevision}，当前为版本 ${m.transcriptRevision}。原文或整理内容已经更新，以下内容属于历史草稿，等待重新整理或人工核对。\n\n`:'';
    const transcript=lines.map(l=>`- [${formatTime(l.startMs)}] ${l.participantId?speakerName(l.participantId,m):m.speakerLabels[l.speakerId] || '未知说话人'}${l.origin!=='asr'?'（人工补充）':''}：${l.text} {#${l.id}}`).join('\n');
    res.type('text/markdown').setHeader('Content-Disposition',`attachment; filename="meeting.md"; filename*=UTF-8''${encodeURIComponent(m.title+'.md')}`);
    res.send(`${revisionNote}${content}\n\n---\n\n## 原始转录\n\n${transcript}\n`);
  });
  app.get('/api/recordings/:id/audio',asyncRoute(async(req,res)=>{
    const args={};
    for(const key of ['startSample','endSample']) if(req.query[key]!==undefined) {args[key]=Number(req.query[key]);if(!Number.isSafeInteger(args[key]) || args[key]<0) throw fail('音频位置无效');}
    const audio=await capture.readAudio(req.params.id,args);
    res.type('audio/wav').send(audio);
  }));
  const indexFile=path.join(distDir,'index.html');
  if(existsSync(indexFile)) {
    app.use(express.static(distDir,{setHeaders:(res,file)=>{if(file===indexFile) res.setHeader('Cache-Control','no-cache');}}));
    // A missing script must stay a 404 rather than becoming the SPA's HTML document.
    app.use('/assets',(req,res,next)=>next(fail('前端资源不存在，请刷新页面',404)));
    app.get('*',(req,res,next)=>req.path.startsWith('/api/')?next():res.sendFile(indexFile,{headers:{'Cache-Control':'no-cache'}}));
  }
  app.use((req,res,next)=>next(fail('接口不存在',404)));
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error.status || (error.type==='entity.parse.failed'?400:500);
    if(status>=500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}: ${error.message}`);
    res.status(status).json({error:status>=500?'处理失败，请查看本地服务日志':error.message});
  });
  ai.start();
  automatic.start();
  imports.start();
  return {app,server,store,ai,capture,imports,voiceprints,automatic,close:async()=>{await automatic.stop();await voiceprints.stop();await imports.stop();await ai.stop();await capture.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});store.close();}};
}
function formatTime(ms=0) {const s=Math.floor(ms/1000);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
