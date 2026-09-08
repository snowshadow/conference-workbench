import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
export function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
const clone = (value) => structuredClone(value);
const bounded = (value, max = 20000) => String(value ?? '').trim().slice(0, max);

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.dataDir, 'audio'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dataDir, 'workbench.sqlite'));
    chmodSync(path.join(this.dataDir, 'workbench.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript (position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_meeting ON transcript(meeting_id,position);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
    `);
    // A process restart cannot leave a physical microphone marked as running.
    for (const meeting of this.listMeetings({ includeArchived: true })) {
      if (['recording', 'paused'].includes(meeting.capture?.state)) this.updateMeeting(meeting.id, { capture: { ...meeting.capture, connected: false, state: 'interrupted', asrState: 'stopped', error: '服务重启，录音已中断' } });
    }
    for (const row of this.db.prepare('SELECT data FROM recordings').all()) {
      const recording = JSON.parse(row.data);
      if (['recording', 'paused'].includes(recording.state)) {
        const audioPath=path.join(this.dataDir,'audio',`${recording.id}.pcm`);
        const sampleCount=existsSync(audioPath)?Math.floor(statSync(audioPath).size/2):0;
        const finalizedEnd=this.allTranscript(recording.meetingId).filter(line=>line.recordingId===recording.id).reduce((end,line)=>Math.max(end,line.endSample || 0),0);
        const gaps=[...(recording.gaps || [])];
        if(finalizedEnd<sampleCount) gaps.push({startSample:finalizedEnd,endSample:sampleCount,reason:'服务重启，尾段未完成转录，可回听核对'});
        this.updateRecording(recording.id, { state: 'interrupted', sampleCount, gaps, endedAt: now() });
      }
    }
    for (const row of this.db.prepare('SELECT data FROM commands').all()) {
      const command = JSON.parse(row.data);
      if (!['done', 'error'].includes(command.status)) this.updateCommand(command.id, { status: 'error', error: '服务已重启，请重新操作' });
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getMeeting(meetingId) {
    const row = this.db.prepare('SELECT data FROM meetings WHERE id=?').get(meetingId);
    if (!row) throw fail('会议不存在', 404);
    return JSON.parse(row.data);
  }
  listMeetings({ archived = false, includeArchived = false } = {}) {
    return this.db.prepare('SELECT data FROM meetings').all().map(r => JSON.parse(r.data))
      .filter(m => includeArchived || Boolean(m.archived) === Boolean(archived))
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  createMeeting(input = {}) {
    const title = bounded(input.title, 200);
    if (!title) throw fail('请填写会议名称');
    const meeting = { id: id(), title, goal: bounded(input.goal, 6000), status: 'planned', archived: false,
      createdAt: now(), updatedAt: now(), transcriptRevision: 0, transcriptEditRevision: 0, contentRevision: 0,
      processedRevision: 0, processedThroughMs: 0, autoOrganize: true, topics: [], followups: [], questions: [], artifacts: [], speakerLabels: {},
      capture: { connected: false, state: 'idle', recordingId: null, asrState: 'stopped', error: null } };
    this.db.prepare('INSERT INTO meetings(id,data) VALUES(?,?)').run(meeting.id, JSON.stringify(meeting));
    return meeting;
  }
  persistMeeting(meeting) {
    meeting.updatedAt = now();
    this.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(meeting), meeting.id);
    return clone(meeting);
  }
  updateMeeting(meetingId, patch) {
    const meeting = this.getMeeting(meetingId);
    const previousSpeakerLabels=meeting.speakerLabels || {};
    const allowed = ['title','goal','status','archived','autoOrganize','speakerLabels','capture','endedAt','processedRevision','processedThroughMs','source','importJobId'];
    let contentChanged = false;
    for (const key of allowed) if (Object.hasOwn(patch, key)) {
      if (['title','goal','speakerLabels'].includes(key) && JSON.stringify(meeting[key]) !== JSON.stringify(patch[key])) contentChanged = true;
      meeting[key] = clone(patch[key]);
    }
    if (Object.hasOwn(patch,'title')) { meeting.title = bounded(patch.title,200); if (!meeting.title) throw fail('会议名称不能为空'); }
    if (Object.hasOwn(patch,'goal')) meeting.goal = bounded(patch.goal,6000);
    if(Object.hasOwn(patch,'speakerLabels')) {
      const labels=meeting.speakerLabels || {};
      const changed=new Set([...Object.keys(previousSpeakerLabels),...Object.keys(labels)].filter(speakerId=>previousSpeakerLabels[speakerId]!==labels[speakerId]));
      const affectedIds=new Set(this.allTranscript(meetingId).filter(line=>changed.has(line.speakerId)).map(line=>line.id));
      if(affectedIds.size) {
        meeting.transcriptEditRevision=(meeting.transcriptEditRevision || 0)+1;
        for(const topic of meeting.topics) for(const entry of topic.entries || []) if((entry.evidenceIds || []).some(id=>affectedIds.has(id))) {entry.stale=true;topic.stale=true;}
        for(const question of meeting.questions) if((question.evidenceIds || []).some(id=>affectedIds.has(id))) question.stale=true;
        for(const followup of meeting.followups) {
          if(['active','recorded'].includes(followup.status) && (followup.evidenceIds || []).some(id=>affectedIds.has(id))) followup.stale=true;
          if((followup.resolution?.evidenceIds || []).some(id=>affectedIds.has(id))) {followup.resolution.stale=true;followup.stale=true;}
        }
        for(const artifact of meeting.artifacts) {artifact.stale=true;artifact.staleReason='speaker_changed';}
        meeting.processedRevision=0;meeting.processedThroughMs=0;
      }
    }
    if (contentChanged) meeting.contentRevision++;
    return this.persistMeeting(meeting);
  }
  mutateMeeting(meetingId, fn) {
    const meeting = this.getMeeting(meetingId);
    const result = fn(meeting);
    const updated = result && typeof result === 'object' && result.id === meetingId ? result : meeting;
    updated.contentRevision = meeting.contentRevision + 1;
    return this.persistMeeting(updated);
  }
  allTranscript(meetingId) {
    this.getMeeting(meetingId);
    return this.db.prepare('SELECT data FROM transcript WHERE meeting_id=? ORDER BY position').all(meetingId).map(r => JSON.parse(r.data));
  }
  getTranscript(meetingId, {cursor=0,limit=100,q=''} = {}) {
    let lines = this.allTranscript(meetingId);
    if (q) lines = lines.filter(line => line.text.toLocaleLowerCase().includes(String(q).toLocaleLowerCase()));
    const start = Math.max(0, Number(cursor) || 0), count = Math.min(500, Math.max(1, Number(limit) || 100));
    return { lines: lines.slice(start,start+count), total: lines.length, nextCursor: start+count < lines.length ? start+count : null };
  }
  appendTranscript(meetingId, input) {
    const text = bounded(input.text, 20000);
    if (!text) throw fail('转录内容不能为空');
    if (input.recordingId && this.getRecording(input.recordingId).meetingId !== meetingId) throw fail('录音不属于本次会议');
    if (input.id) {
      const existing = this.db.prepare('SELECT meeting_id,data FROM transcript WHERE id=?').get(input.id);
      if (existing) {
        if (existing.meeting_id !== meetingId) throw fail('来源不属于本次会议');
        const old = JSON.parse(existing.data);
        if (old.text === text && old.speakerId === (input.speakerId || '')) return old;
        return this.editTranscript(meetingId,input.id,{...input,origin:input.origin || 'asr',text,speakerId:input.speakerId || ''});
      }
    }
    return this.transaction(() => {
      const meeting = this.getMeeting(meetingId);
      const previous = this.db.prepare('SELECT data FROM transcript WHERE meeting_id=? ORDER BY position DESC LIMIT 1').get(meetingId);
      const fallback = previous ? JSON.parse(previous.data).endMs : 0;
      const line = { id: input.id || id(), meetingId, recordingId: input.recordingId || null, text, speakerId: bounded(input.speakerId,100),
        startSample: Number.isFinite(input.startSample) ? input.startSample : null, endSample: Number.isFinite(input.endSample) ? input.endSample : null,
        startMs: Number.isFinite(input.startMs) ? input.startMs : fallback, endMs: Number.isFinite(input.endMs) ? input.endMs : (input.startMs ?? fallback),
        origin: input.origin || 'asr', ...(input.timing==='chunk'?{timing:'chunk'}:{}), revision: 1, createdAt: now() };
      this.db.prepare('INSERT INTO transcript(id,meeting_id,data) VALUES(?,?,?)').run(line.id,meetingId,JSON.stringify(line));
      meeting.transcriptRevision++;
      // Old answers remain visible with their explicit evidence cutoff; new speech is not a correction.
      for (const item of meeting.followups) if (item.status === 'active') item.pendingReview = true;
      for (const item of meeting.artifacts) item.stale = true;
      this.persistMeeting(meeting);
      return line;
    });
  }
  editTranscript(meetingId, lineId, patch) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM transcript WHERE id=? AND meeting_id=?').get(lineId,meetingId);
      if (!row) throw fail('转录片段不存在',404);
      const line = JSON.parse(row.data);
      // A delayed ASR correction must not replace a host or Agent correction.
      if (patch.origin === 'asr' && line.origin !== 'asr') return line;
      const old = {text:line.text,speakerId:line.speakerId,revision:line.revision,editedAt:now()};
      if (Object.hasOwn(patch,'text')) { line.text = bounded(patch.text,20000); if (!line.text) throw fail('转录内容不能为空'); }
      if (Object.hasOwn(patch,'speakerId')) line.speakerId = bounded(patch.speakerId,100);
      if (patch.origin==='asr' && line.origin==='asr') {
        for(const key of ['startSample','endSample','startMs','endMs']) if(Number.isFinite(patch[key])) line[key]=patch[key];
      } else line.origin=patch.origin==='agent'?'agent':'host';
      line.history = [...(line.history || []),old]; line.revision++; line.editedAt = now();
      this.db.prepare('UPDATE transcript SET data=? WHERE id=?').run(JSON.stringify(line),lineId);
      const meeting = this.getMeeting(meetingId);
      meeting.transcriptRevision++; meeting.transcriptEditRevision = (meeting.transcriptEditRevision || 0)+1; meeting.contentRevision++;
      // Regenerate from the start after a correction so already processed evidence is reconsidered.
      meeting.processedRevision = 0; meeting.processedThroughMs = 0;
      for (const topic of meeting.topics) for (const entry of topic.entries || []) if ((entry.evidenceIds || []).includes(lineId)) { entry.stale = true; topic.stale = true; }
      for (const followup of meeting.followups) {
        if (followup.status === 'active' || followup.status === 'recorded' && (followup.evidenceIds || []).includes(lineId)) followup.stale = true;
        if ((followup.resolution?.evidenceIds || []).includes(lineId)) {followup.resolution.stale=true;followup.stale=true;}
      }
      for (const question of meeting.questions) if ((question.evidenceIds || []).includes(lineId)) question.stale = true;
      for (const artifact of meeting.artifacts) artifact.stale = true;
      this.persistMeeting(meeting);
      return line;
    });
  }
  createRecord(table, meetingId, fields) {
    this.getMeeting(meetingId);
    const row = {id:id(),meetingId,...fields,createdAt:now(),updatedAt:now()};
    this.db.prepare(`INSERT INTO ${table}(id,meeting_id,data) VALUES(?,?,?)`).run(row.id,meetingId,JSON.stringify(row)); return row;
  }
  getRecord(table, recordId) {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(recordId);
    if (!row) throw fail('记录不存在',404); return JSON.parse(row.data);
  }
  updateRecord(table, recordId, patch) {
    const prior = this.getRecord(table, recordId), row = {...prior,...clone(patch),id:prior.id,meetingId:prior.meetingId,updatedAt:now()};
    this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(row),recordId); return row;
  }
  listRecords(table, meetingId) {
    const rows = meetingId ? this.db.prepare(`SELECT data FROM ${table} WHERE meeting_id=?`).all(meetingId) : this.db.prepare(`SELECT data FROM ${table}`).all();
    return rows.map(r=>JSON.parse(r.data)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  createJob(meetingId,type,input={}) { return this.createRecord('jobs',meetingId,{type,input,status:'queued',result:null,error:null}); }
  annotateJob(job) {
    if(job.status!=='done' || !job.result || !['answer','minutes'].includes(job.type)) return job;
    const meeting=this.getMeeting(job.meetingId);
    const current=job.type==='answer' ? meeting.questions.find(item=>item.id===job.result.id) : meeting.artifacts.find(item=>item.id===job.result.id);
    const replaced=job.type==='minutes' && current && (current.markdown!==job.result.markdown || current.title!==job.result.title || current.sourceRevision!==job.result.sourceRevision);
    // Keep the immutable historical text; only report its present validity to Agent readers.
    return {...job,result:{...job.result,stale:Boolean(job.result.stale || !current || current.stale || replaced),hasNewerTranscript:Number.isInteger(job.result.sourceRevision) && job.result.sourceRevision<meeting.transcriptRevision}};
  }
  getJob(jobId) {return this.annotateJob(this.getRecord('jobs',jobId));}
  updateJob(jobId,patch) {return this.updateRecord('jobs',jobId,patch);}
  listJobs(meetingId) {return this.listRecords('jobs',meetingId).map(job=>this.annotateJob(job));}
  pendingJobs() {return this.listJobs().filter(j=>['queued','running'].includes(j.status));}
  createCommand(meetingId,action) {return this.createRecord('commands',meetingId,{action,status:'pending',result:null,error:null});}
  getCommand(commandId) {return this.getRecord('commands',commandId);}
  updateCommand(commandId,patch) {return this.updateRecord('commands',commandId,patch);}
  listCommands(meetingId) {return this.listRecords('commands',meetingId);}
  createRecording(meetingId,{timelineStartMs=0,...extra}={}) { return this.createRecord('recordings',meetingId,{sampleCount:0,sampleRate:16000,startedAt:now(),endedAt:null,state:'recording',gaps:[],timelineStartMs,...extra}); }
  getRecording(recordingId) {return this.getRecord('recordings',recordingId);}
  updateRecording(recordingId,patch) {return this.updateRecord('recordings',recordingId,patch);}
  listRecordings(meetingId) {return this.listRecords('recordings',meetingId);}
  getSettings() {
    const saved = JSON.parse(this.db.prepare('SELECT data FROM settings WHERE id=1').get()?.data || '{}');
    return { llm: {baseUrl:process.env.LLM_BASE_URL || 'https://api.deepseek.com',model:process.env.LLM_MODEL || 'deepseek-chat',apiKey:process.env.LLM_API_KEY || '',...saved.llm},
      asr: {apiKey:process.env.VOLCENGINE_ASR_API_KEY || '',appKey:process.env.VOLCENGINE_ASR_APP_KEY || '',accessKey:process.env.VOLCENGINE_ASR_ACCESS_KEY || '',resourceId:process.env.VOLCENGINE_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',...saved.asr},
      fileAsr: {baseUrl:process.env.FILE_ASR_BASE_URL || process.env.OMLX_BASE_URL || 'http://127.0.0.1:8000',model:process.env.FILE_ASR_MODEL || process.env.OMLX_ASR_MODEL || 'Qwen3-ASR-1.7B-8bit',apiKey:process.env.FILE_ASR_API_KEY ?? process.env.OMLX_API_KEY ?? '',language:process.env.FILE_ASR_LANGUAGE || 'zh',...saved.fileAsr} };
  }
  publicSettings() {
    const {llm,asr,fileAsr} = this.getSettings();
    let local=false;try{local=['127.0.0.1','localhost','[::1]'].includes(new URL(llm.baseUrl).hostname);}catch{}
    let fileLocal=false;try{fileLocal=['127.0.0.1','localhost','[::1]'].includes(new URL(fileAsr.baseUrl).hostname);}catch{}
    return {llm:{baseUrl:llm.baseUrl,model:llm.model,reasoningEffort:llm.reasoningEffort || '',configured:Boolean(llm.baseUrl && llm.model && (llm.apiKey || local))},asr:{resourceId:asr.resourceId,configured:Boolean(asr.apiKey || (asr.appKey && asr.accessKey))},fileAsr:{baseUrl:fileAsr.baseUrl,model:fileAsr.model,language:fileAsr.language,configured:Boolean(fileAsr.baseUrl && fileAsr.model && (fileAsr.apiKey || fileLocal))}};
  }
  saveSettings(input={}) {
    const settings = this.getSettings();
    if (input.llm && Object.hasOwn(input.llm,'reasoningEffort')) {
      if (!['','low'].includes(input.llm.reasoningEffort)) throw fail('思考强度请选择模型默认或较低');
      settings.llm.reasoningEffort = input.llm.reasoningEffort;
    }
    for (const [group,keys] of Object.entries({llm:['baseUrl','model','apiKey'],asr:['apiKey','appKey','accessKey','resourceId'],fileAsr:['baseUrl','model','apiKey','language']})) {
      for (const key of keys) if (input[group]?.[key]?.trim()) settings[group][key] = bounded(input[group][key],4000);
    }
    for(const [group,label] of [['llm','大模型'],['fileAsr','录音转录']]) {
      let url; try {url=new URL(settings[group].baseUrl);} catch {throw fail(`${label} API 地址无效`);}
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw fail('API 地址只支持 HTTP(S)，且不能包含账号密码');
    }
    this.db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings));
    return this.publicSettings();
  }
  saveArtifact(meetingId,type,input) {
    let artifact;
    this.mutateMeeting(meetingId,m=>{
      const prior=m.artifacts.find(a=>a.type===type);
      const history=prior ? [...(prior.history || []),{markdown:prior.markdown,author:prior.author,updatedAt:prior.updatedAt,sourceRevision:prior.sourceRevision}] : [];
      artifact={id:prior?.id || id(),type,title:bounded(input.title || '会议纪要',200),markdown:String(input.markdown || '').slice(0,250000),author:input.author || 'host',sourceRevision:input.sourceRevision ?? m.transcriptRevision,updatedAt:now(),stale:(input.sourceRevision ?? m.transcriptRevision)!==m.transcriptRevision,history};
      m.artifacts=prior ? m.artifacts.map(a=>a.id===prior.id?artifact:a) : [...m.artifacts,artifact];
    });
    return clone(artifact);
  }
  close() {this.db.close();}
}
