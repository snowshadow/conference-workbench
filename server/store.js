import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as people from './people/store.js';
import { presentPeopleReviewError } from './ai/people-errors.js';

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
      CREATE INDEX IF NOT EXISTS meetings_created_page ON meetings (coalesce(json_extract(data,'$.archived'),0),json_extract(data,'$.createdAt') DESC,id DESC);
      CREATE TABLE IF NOT EXISTS transcript (position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_meeting ON transcript(meeting_id,position);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
    `);
    // A process restart cannot leave a physical microphone marked as running.
    for (const meeting of this.listMeetings({ includeArchived: true })) {
      let recognitionInterrupted = false;
      for (const participant of meeting.participants || []) if (['queued', 'running'].includes(participant.recognition?.status)) {
        participant.recognition = { ...participant.recognition, status: 'error', error: '服务已重启', message: '等新的清晰发言后再试', nextAttemptAt: null, updatedAt: now() };
        recognitionInterrupted = true;
      }
      if (recognitionInterrupted) this.persistMeeting(meeting);
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
    return people.projectPeople(JSON.parse(row.data), this.rawTranscript(meetingId), this.listMembers());
  }
  listMeetings({ archived = false, includeArchived = false } = {}) {
    return this.db.prepare('SELECT id FROM meetings').all().map(r => this.getMeeting(r.id))
      .filter(m => includeArchived || Boolean(m.archived) === Boolean(archived))
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  listMeetingsPage({ archived = false, limit = 20, cursor } = {}) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw fail('每页会议数量须为 1 到 100。');
    let boundary;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error();
        boundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(boundary) || boundary.length !== 2 || boundary.some(value => typeof value !== 'string' || !value || value.length > 100)) throw new Error();
      } catch { throw fail('会议列表的翻页位置无效，请刷新列表。'); }
    }
    // Read only a page of summaries. Unlike getMeeting, this does not load the
    // meeting's transcript or project its speaker identities.
    const rows = this.db.prepare(`WITH page AS (
      SELECT id,data FROM meetings
      WHERE coalesce(json_extract(data,'$.archived'),0)=?
      ${boundary ? "AND (json_extract(data,'$.createdAt'),id)<(?,?)" : ''}
      ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?
    ) SELECT id,json_extract(data,'$.title') AS title,json_extract(data,'$.goal') AS goal,
      json_extract(data,'$.status') AS status,json_extract(data,'$.archived') AS archived,
      json_extract(data,'$.createdAt') AS createdAt,json_extract(data,'$.updatedAt') AS updatedAt,
      json_extract(data,'$.transcriptRevision') AS transcriptRevision,
      (SELECT count(*) FROM json_each(page.data,'$.topics') AS topic
        WHERE json_extract(topic.value,'$.mergedInto') IS NULL OR json_extract(topic.value,'$.mergedInto') IN ('',0)) AS topicCount
      FROM page`).all(Number(Boolean(archived)), ...(boundary || []), count + 1);
    const hasMore = rows.length > count;
    const meetings = rows.slice(0, count).map(row => ({ ...row, archived: Boolean(row.archived) }));
    const last = meetings.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null;
    return { meetings, nextCursor, hasMore };
  }
  createMeeting(input = {}) {
    const title = bounded(input.title, 200);
    if (!title) throw fail('请填写会议名称');
    const meeting = { id: id(), title, goal: bounded(input.goal, 6000), status: 'planned', archived: false,
      createdAt: now(), updatedAt: now(), transcriptRevision: 0, transcriptEditRevision: 0, contentRevision: 0,
      processedRevision: 0, processedThroughMs: 0, autoOrganize: true, topics: [], followups: [], questions: [], artifacts: [], speakerLabels: {}, participants: [], identityRevision: 0,
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
    const labelsChanged = Object.hasOwn(patch, 'speakerLabels') &&
      Object.keys({ ...meeting.speakerLabels, ...patch.speakerLabels }).some(key => meeting.speakerLabels?.[key] !== patch.speakerLabels?.[key]);
    const allowed = ['title','goal','status','archived','autoOrganize','speakerLabels','capture','endedAt','processedRevision','processedThroughMs','source','importJobId'];
    let contentChanged = false;
    for (const key of allowed) if (Object.hasOwn(patch, key)) {
      if (['title','goal'].includes(key) && JSON.stringify(meeting[key]) !== JSON.stringify(patch[key]) || key === 'speakerLabels' && labelsChanged) contentChanged = true;
      meeting[key] = clone(patch[key]);
    }
    if (Object.hasOwn(patch,'title')) { meeting.title = bounded(patch.title,200); if (!meeting.title) throw fail('会议名称不能为空'); }
    if (Object.hasOwn(patch,'goal')) meeting.goal = bounded(patch.goal,6000);
    if (Object.hasOwn(patch, 'speakerLabels')) people.applyLegacySpeakerLabels(meeting, patch.speakerLabels);
    // Names label stable speaker IDs; only editTranscript changes who said a line.
    // Keep existing discussion and its watermark while contentRevision rejects AI
    // results still using the old names. Never clear earlier source corrections.
    if (contentChanged) meeting.contentRevision++;
    if (labelsChanged) meeting.identityRevision = (meeting.identityRevision || 0) + 1;
    return this.persistMeeting(meeting);
  }
  mutateMeeting(meetingId, fn) {
    const meeting = this.getMeeting(meetingId);
    const result = fn(meeting);
    const updated = result && typeof result === 'object' && result.id === meetingId ? result : meeting;
    updated.contentRevision = meeting.contentRevision + 1;
    return this.persistMeeting(updated);
  }
  rawTranscript(meetingId) {
    return this.db.prepare('SELECT data FROM transcript WHERE meeting_id=? ORDER BY position').all(meetingId).map(r => JSON.parse(r.data));
  }
  allTranscript(meetingId) {
    const meeting = this.getMeeting(meetingId);
    return this.rawTranscript(meetingId).map(line => ({ ...line, participantId: people.participantForLine(meeting, line)?.id || null }));
  }
  listMembers() { return people.listMembers(this); }
  getMember(memberId) { return people.getMember(this, memberId); }
  createMember(input) { return people.createMember(this, input); }
  updateMember(memberId, input) { return people.updateMember(this, memberId, input); }
  listParticipants(meetingId) { return this.getMeeting(meetingId).participants.filter(item => !item.mergedInto); }
  createParticipant(meetingId, input) { return people.createParticipant(this, meetingId, input); }
  updateParticipant(meetingId, participantId, input) { return people.updateParticipant(this, meetingId, participantId, input); }
  setParticipantRecognition(meetingId, participantId, input) { return people.setParticipantRecognition(this, meetingId, participantId, input); }
  applyRecognizedParticipant(meetingId, participantId, candidate, input) { return people.applyRecognizedParticipant(this, meetingId, participantId, candidate, input); }
  mergeParticipants(meetingId, sourceId, targetId) { return people.mergeParticipants(this, meetingId, sourceId, targetId); }
  assignTranscriptParticipant(meetingId, lineId, participantId, input) { return people.assignTranscriptParticipant(this, meetingId, lineId, participantId, input); }
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
        if (old.text === text && old.speakerId === (input.speakerId || '')) return this.allTranscript(meetingId).find(line => line.id === old.id);
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
        origin: input.origin || 'asr', ...(input.timing==='chunk'?{timing:'chunk'}:{}),
        ...(input.recognitionSessionId ? { recognitionSessionId: bounded(input.recognitionSessionId,100), providerSpeakerId: bounded(input.providerSpeakerId,60) } : {}),
        revision: 1, createdAt: now() };
      const participant = people.ensureParticipant(meeting, line);
      this.db.prepare('INSERT INTO transcript(id,meeting_id,data) VALUES(?,?,?)').run(line.id,meetingId,JSON.stringify(line));
      meeting.transcriptRevision++;
      // Old answers remain visible with their explicit evidence cutoff; new speech is not a correction.
      for (const item of meeting.followups) if (item.status === 'active') item.pendingReview = true;
      for (const item of meeting.artifacts) item.stale = true;
      this.persistMeeting(meeting);
      return { ...line, participantId: participant.id };
    });
  }
  editTranscript(meetingId, lineId, patch) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM transcript WHERE id=? AND meeting_id=?').get(lineId,meetingId);
      if (!row) throw fail('转录片段不存在',404);
      const line = JSON.parse(row.data);
      // A delayed ASR correction must not replace a host or Agent correction.
      if (patch.origin === 'asr' && line.origin !== 'asr') return this.allTranscript(meetingId).find(item => item.id === line.id);
      const old = {text:line.text,speakerId:line.speakerId,revision:line.revision,editedAt:now()};
      if (Object.hasOwn(patch,'text')) { line.text = bounded(patch.text,20000); if (!line.text) throw fail('转录内容不能为空'); }
      if (Object.hasOwn(patch,'speakerId')) {
        line.speakerId = bounded(patch.speakerId,100);
        if (patch.origin !== 'asr') { delete line.participantId; delete line.participantSource; }
      }
      if (patch.origin==='asr' && line.origin==='asr') {
        for(const key of ['startSample','endSample','startMs','endMs']) if(Number.isFinite(patch[key])) line[key]=patch[key];
      } else line.origin=patch.origin==='agent'?'agent':'host';
      line.history = [...(line.history || []),old]; line.revision++; line.editedAt = now();
      this.db.prepare('UPDATE transcript SET data=? WHERE id=?').run(JSON.stringify(line),lineId);
      const meeting = this.getMeeting(meetingId);
      const participant = people.ensureParticipant(meeting, line);
      meeting.transcriptRevision++; meeting.transcriptEditRevision = (meeting.transcriptEditRevision || 0)+1; meeting.contentRevision++;
      // Regenerate from the start after a correction so already processed evidence is reconsidered.
      meeting.processedRevision = 0; meeting.processedThroughMs = 0;
      for (const topic of meeting.topics) for (const entry of topic.entries || []) if ((entry.evidenceIds || []).includes(lineId)) { entry.stale = true; topic.stale = true; }
      for (const followup of meeting.followups) {
        if (followup.status === 'active' || (followup.evidenceIds || []).includes(lineId)) followup.stale = true;
        if ((followup.clarification?.evidenceIds || []).includes(lineId)) followup.clarification.stale = true;
        for (const part of followup.clarification?.distinctions || []) if ((part.evidenceIds || []).includes(lineId)) part.stale = true;
        if ((followup.attention?.evidenceIds || []).includes(lineId)) followup.attention.stale = true;
        if ((followup.priority?.evidenceIds || []).includes(lineId)) followup.priority.stale = true;
        if ((followup.resolution?.evidenceIds || []).includes(lineId)) {followup.resolution.stale=true;followup.stale=true;}
      }
      for (const question of meeting.questions) if ((question.evidenceIds || []).includes(lineId)) question.stale = true;
      for (const artifact of meeting.artifacts) artifact.stale = true;
      this.persistMeeting(meeting);
      return { ...line, participantId: participant.id };
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
    job = { ...job, error: presentPeopleReviewError(job) };
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
    // Keep an existing OpenAI-compatible file provider until it is explicitly
    // switched. Fresh installations use the shared Volcengine credentials.
    const fileProvider = process.env.FILE_ASR_PROVIDER || (saved.fileAsr?.baseUrl || process.env.FILE_ASR_BASE_URL || process.env.OMLX_BASE_URL ? 'openai' : 'volcengine');
    return { llm: {baseUrl:process.env.LLM_BASE_URL || 'https://api.deepseek.com',model:process.env.LLM_MODEL || 'deepseek-chat',apiKey:process.env.LLM_API_KEY || '',...saved.llm},
      asr: {apiKey:process.env.VOLCENGINE_ASR_API_KEY || '',appKey:process.env.VOLCENGINE_ASR_APP_KEY || '',accessKey:process.env.VOLCENGINE_ASR_ACCESS_KEY || '',resourceId:process.env.VOLCENGINE_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',...saved.asr},
      fileAsr: {provider:fileProvider,resourceId:process.env.FILE_ASR_RESOURCE_ID || 'volc.bigasr.auc_turbo',baseUrl:process.env.FILE_ASR_BASE_URL || process.env.OMLX_BASE_URL || 'http://127.0.0.1:8000',model:process.env.FILE_ASR_MODEL || process.env.OMLX_ASR_MODEL || 'Qwen3-ASR-1.7B-8bit',apiKey:process.env.FILE_ASR_API_KEY ?? process.env.OMLX_API_KEY ?? '',language:process.env.FILE_ASR_LANGUAGE || 'zh',...saved.fileAsr} };
  }
  publicSettings() {
    const {llm,asr,fileAsr} = this.getSettings();
    let local=false;try{local=['127.0.0.1','localhost','[::1]'].includes(new URL(llm.baseUrl).hostname);}catch{}
    let fileLocal=false;try{fileLocal=['127.0.0.1','localhost','[::1]'].includes(new URL(fileAsr.baseUrl).hostname);}catch{}
    const asrConfigured = Boolean(asr.apiKey || (asr.appKey && asr.accessKey));
    return {llm:{baseUrl:llm.baseUrl,model:llm.model,reasoningEffort:llm.reasoningEffort || '',configured:Boolean(llm.baseUrl && llm.model && (llm.apiKey || local))},asr:{resourceId:asr.resourceId,configured:asrConfigured},fileAsr:{provider:fileAsr.provider,resourceId:fileAsr.resourceId,baseUrl:fileAsr.baseUrl,model:fileAsr.model,language:fileAsr.language,configured:fileAsr.provider === 'volcengine' ? asrConfigured : Boolean(fileAsr.baseUrl && fileAsr.model && (fileAsr.apiKey || fileLocal))}};
  }
  saveSettings(input={}) {
    const settings = this.getSettings();
    if (input.fileAsr && Object.hasOwn(input.fileAsr,'provider')) {
      if (!['volcengine','openai'].includes(input.fileAsr.provider)) throw fail('请选择火山引擎或 OpenAI 兼容文件转录服务');
      settings.fileAsr.provider = input.fileAsr.provider;
    } else if (input.fileAsr?.baseUrl?.trim() || input.fileAsr?.model?.trim()) {
      // Older API clients configure this provider by its URL/model alone.
      settings.fileAsr.provider = 'openai';
    }
    if (input.llm && Object.hasOwn(input.llm,'reasoningEffort')) {
      if (!['','low'].includes(input.llm.reasoningEffort)) throw fail('思考强度请选择模型默认或较低');
      settings.llm.reasoningEffort = input.llm.reasoningEffort;
    }
    for (const [group,keys] of Object.entries({llm:['baseUrl','model','apiKey'],asr:['apiKey','appKey','accessKey','resourceId'],fileAsr:['baseUrl','model','apiKey','language','resourceId']})) {
      for (const key of keys) if (input[group]?.[key]?.trim()) settings[group][key] = bounded(input[group][key],4000);
    }
    for(const [group,label] of [['llm','大模型'],['fileAsr','录音转录']]) {
      if (group === 'fileAsr' && settings.fileAsr.provider === 'volcengine') continue;
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
