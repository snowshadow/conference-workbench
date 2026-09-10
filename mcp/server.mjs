import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { recommendedFocusId } from '../shared/discussion-view.js';

function withoutHistory(value) {
  if (!value || typeof value !== 'object') return value;
  const { history, ...current } = value;
  return current;
}

function currentFollowup(value) {
  const item = withoutHistory(value);
  if (item.resolution) item.resolution = withoutHistory(item.resolution);
  if (item.attention) item.attention = withoutHistory(item.attention);
  if (item.priority) item.priority = withoutHistory(item.priority);
  if (item.clarification) {
    item.clarification = withoutHistory(item.clarification);
    if (Array.isArray(item.clarification.distinctions)) item.clarification.distinctions = item.clarification.distinctions.map(withoutHistory);
  }
  return item;
}

export function createMCPServer({baseUrl=process.env.WORKBENCH_URL || 'http://127.0.0.1:8797'}={}) {
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('WORKBENCH_URL 必须指向本机会议工作台');
  const server=new McpServer({name:'meeting-workbench',version:'0.1.2'});
  const id=z.string().min(1).max(160),mid={meetingId:id};
  const enc=encodeURIComponent;
  async function request(resource,method='GET',body) {
    const response=await fetch(`${url.origin}${resource}`,{method,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    const data=await response.json(); if(!response.ok)throw new Error(data.error || `请求失败 ${response.status}`);return data;
  }
  function tool(name,description,inputSchema,fn,readOnly=false) {
    server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false}},async input=>{
      try {const result=await fn(input);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
      catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
    });
  }
  tool('list_meetings','列出会议概况，不载入转录。归档会议可查询和恢复。',{archived:z.boolean().default(false)},input=>request(`/api/meetings?archived=${input.archived?1:0}`),true);
  tool('create_meeting','创建会议。此操作不会开始录音。',{title:z.string().min(1).max(200),goal:z.string().max(6000).default('')},input=>request('/api/meetings','POST',input));
  tool('import_recording','将用户指定的本机录音导入为一场已结束的会议。流式上传后返回 meeting 和导入 job，用 get_ai_job 查询转录进度。原文件与可回听音频保存在本机；配置文件 ASR 后执行转录，配置 LLM 后自动整理。无需浏览器麦克风授权。',{filePath:z.string().min(1),title:z.string().max(200).optional(),goal:z.string().max(6000).optional()},async({filePath,title,goal})=>{
    if(!path.isAbsolute(filePath))throw new Error('请提供录音文件的绝对路径');
    const file=await stat(filePath);
    if(!file.isFile()||!file.size)throw new Error('请选择非空的录音文件');
    if(file.size>512*1024**2)throw new Error('录音文件超过 512 MiB，请拆分后导入');
    const form=new FormData();
    if(title)form.append('title',title);
    if(goal)form.append('goal',goal);
    form.append('file',await openAsBlob(filePath),path.basename(filePath));
    const response=await fetch(`${url.origin}/api/meetings/import`,{method:'POST',headers:{Accept:'application/json'},body:form,signal:AbortSignal.timeout(300000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||`导入失败 ${response.status}`);return data;
  });
  tool('retry_recording_import','继续失败的录音导入，从已完成的分段之后转录。保留原音频、已完成的文字与人工修正；已完成任务直接返回当前状态。',mid,({meetingId})=>request(`/api/meetings/${enc(meetingId)}/import/retry`,'POST',{}));
  tool('update_meeting','修改会议名称、目标、自动整理或归档状态。结束会议请用 control_recording 的 end。',{...mid,title:z.string().min(1).max(200).optional(),goal:z.string().max(6000).optional(),archived:z.boolean().optional(),autoOrganize:z.boolean().optional(),speakerLabels:z.record(z.string(),z.string()).optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}`,'PATCH',input));
  tool('get_meeting_context','读取主题、讨论条目、活跃澄清及已记录的澄清进展、录音真实状态和产物索引。检查 stale 与 author；澄清记录不等于参会者共识。原始转录须分页读取，产物全文用 get_artifact。',mid,async({meetingId})=>{
    const m=await request(`/api/meetings/${enc(meetingId)}`);
    return {id:m.id,title:m.title,goal:m.goal,status:m.status,source:m.source,importJobId:m.importJobId,archived:m.archived,transcriptRevision:m.transcriptRevision,transcriptEditRevision:m.transcriptEditRevision,processedRevision:m.processedRevision,processedThroughMs:m.processedThroughMs,capture:m.capture,speakerLabels:m.speakerLabels,focusFollowupId:recommendedFocusId(m),
      participants:m.participants,identityRevision:m.identityRevision,
      topics:m.topics.filter(t=>!t.mergedInto).map(({history,entries,...topic})=>({...topic,entries:entries.map(({history,...entry})=>entry)})),
      followups:m.followups.filter(f=>!f.mergedInto && (f.status==='active'||f.resolution)).map(currentFollowup),recordings:m.recordings,
      artifacts:m.artifacts.map(({id,type,title,author,sourceRevision,stale,updatedAt})=>({id,type,title,author,sourceRevision,stale,updatedAt})),jobs:m.jobs.map(({id,type,status,error,progress,promptVersion,model,sourceRevision})=>({id,type,status,error,progress,promptVersion,model,sourceRevision}))};
  },true);
  tool('get_transcript_chunk','分页读取本次会议原始转录，可用 q 在转录中检索。nextCursor 为 null 表示读完。',{...mid,cursor:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(500).default(100),q:z.string().max(500).optional()},({meetingId,...query})=>request(`/api/meetings/${enc(meetingId)}/transcript?${new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]))}`),true);
  tool('get_meeting_speakers','读取本场参会者、团队成员、可回听样本和已保存声纹。participantId 是会内稳定身份；原始 ASR 编号不能跨连接或跨会议用于认人。',mid,({meetingId})=>request(`/api/meetings/${enc(meetingId)}/people`),true);
  tool('save_team_member','按用户确认的姓名创建或修改团队成员。已有成员使用 memberId；修改姓名会同步到关联会议，不自动登记声音。',{memberId:id.optional(),name:z.string().trim().min(1).max(100)},({memberId,...input})=>request(memberId?`/api/members/${enc(memberId)}`:'/api/members',memberId?'PATCH':'POST',input));
  tool('create_meeting_speaker','为本场会议创建一位参会者，用于给尚未归属的发言标记姓名。默认仅在本场使用；memberId 关联已有团队成员。',{...mid,name:z.string().trim().min(1).max(100),memberId:id.optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}/participants`,'POST',input));
  tool('label_meeting_speaker','根据主持人的确认标记姓名，或关联团队成员。memberId=null 仅使用本场姓名。仅改名不会重算已有结构化分析；旧分析中的姓名会按来源核对更新。不会登记声纹。',{...mid,participantId:id,name:z.string().trim().min(1).max(100).optional(),memberId:id.nullable().optional()},({meetingId,participantId,...input})=>request(`/api/meetings/${enc(meetingId)}/participants/${enc(participantId)}`,'PATCH',input));
  tool('merge_meeting_speakers','主持人已确认两个分组属于同一人时，合并到目标参会者，保留原始识别编号与修改依据，相关分析自动核对。不能仅凭编号或名字相似合并。',{...mid,sourceParticipantId:id,targetParticipantId:id},({meetingId,sourceParticipantId,targetParticipantId})=>request(`/api/meetings/${enc(meetingId)}/participants/${enc(sourceParticipantId)}/merge`,'POST',{targetId:targetParticipantId}));
  tool('assign_transcript_speaker','纠正一段发言的实际说话人；使用本场 participantId。保留原文和人工记录，自动核对受影响的观点和分歧。',{...mid,lineId:id,participantId:id},({meetingId,lineId,participantId})=>request(`/api/meetings/${enc(meetingId)}/transcript/${enc(lineId)}/participant`,'PATCH',{participantId,author:'agent'}));
  tool('get_voiceprint_status','读取本地声纹运行时、自动识别条件、可用样本及任务状态。相似度不代表身份概率。',{},()=>request('/api/voiceprints/status'),true);
  tool('enroll_speaker_voiceprint','用户明确同意保存该说话人的声音样本后使用。选择人工确认属于同一人的 2–4 段清晰原文，每段至少3秒、至少4个字。team 范围需先关联团队成员，meeting 范围只在本场使用。返回本地任务，声音不发往云端。',{...mid,participantId:id,sourceIds:z.array(id).min(2).max(4),scope:z.enum(['meeting','team'])},({meetingId,participantId,...input})=>request(`/api/meetings/${enc(meetingId)}/participants/${enc(participantId)}/voiceprints/enroll`,'POST',input));
  tool('suggest_speaker_identity','在本机将声音与团队及本场样本比较；省略 sourceIds 时自动选取合格片段。此工具只返回候选，主持人确认后调用 label_meeting_speaker 或 merge_meeting_speakers。',{...mid,participantId:id,sourceIds:z.array(id).min(2).max(4).optional()},({meetingId,participantId,...input})=>request(`/api/meetings/${enc(meetingId)}/participants/${enc(participantId)}/voiceprints/match`,'POST',input));
  tool('retry_speaker_recognition','重新识别指定的未命名说话人；自动选段，多段结果足够一致时采用团队姓名，否则保存候选等待确认。已手动命名的说话人不会改名。用 get_meeting_speakers 回读 recognition。',{...mid,participantId:id},({meetingId,participantId})=>request(`/api/meetings/${enc(meetingId)}/participants/${enc(participantId)}/recognition/retry`,'POST',{}));
  tool('list_voiceprint_profiles','读取团队声音样本及来源、回听区间和可用状态，不返回特征向量。',{},()=>request('/api/voiceprints/profiles'),true);
  tool('set_voiceprint_enabled','按用户要求启用或停用已登记的声音样本；停用保留样本及来源，不再用来识别人。',{profileId:id,enabled:z.boolean()},({profileId,enabled})=>request(`/api/voiceprints/profiles/${enc(profileId)}`,'PATCH',{enabled}));
  tool('get_voiceprint_job','读取声音登记或匹配任务状态，done 表示计算完成。自动识别是否已采用姓名，用 get_meeting_speakers 回读；弱候选仍需主持人确认。',{jobId:id},({jobId})=>request(`/api/voiceprint-jobs/${enc(jobId)}`),true);
  tool('correct_transcript','更正原始转录文字或说话人。保留历史，并使受影响的 AI 结果等待重新整理。',{...mid,lineId:id,text:z.string().min(1).max(20000).optional(),speakerId:z.string().max(100).optional()},({meetingId,lineId,...input})=>request(`/api/meetings/${enc(meetingId)}/transcript/${enc(lineId)}`,'PATCH',{...input,author:'agent'}));
  tool('add_meeting_note','按用户提供的现场事实补充记录，明确标记为人工补充。不能将 AI 分析或推测写成参会者发言。',{...mid,text:z.string().min(1).max(20000),speakerId:z.string().max(100).optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}/transcript`,'POST',{...input,author:'agent'}));
  tool('control_recording','请求实际浏览器采集操作。返回 command 状态，不等于立即成功；needs_user_action 需要主持人在页面点击授权；done 才代表实际完成。end 保存尾段并结束会议。',{...mid,action:z.enum(['start','pause','resume','stop','end'])},({meetingId,action})=>request(`/api/meetings/${enc(meetingId)}/commands`,'POST',{action}));
  tool('get_recording_command','回读录音控制的实际执行结果。',{commandId:id},({commandId})=>request(`/api/commands/${enc(commandId)}`),true);
  tool('organize_meeting','基于已保存转录整理讨论并识别值得澄清的阻碍，例如概念差异、隐含前提和取舍标准；也可深入追问或生成纪要。返回异步任务，用 get_ai_job 回读。organize 搭配 force=true 重读全部转录，适合测试修改后的提示词；保留人工修正和既有澄清记录。',{...mid,type:z.enum(['organize','followup','minutes']).default('organize'),topicId:id.optional(),force:z.boolean().optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}/jobs`,'POST',input));
  tool('ask_meeting','仅依据本次会议转录回答，可限定主题。区分原话依据与 AI 推断；返回异步任务。',{...mid,question:z.string().min(1).max(6000),topicId:id.optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}/jobs`,'POST',{type:'answer',...input}));
  tool('get_ai_job','读取导入或 AI 任务的状态、进度、结果与失败原因。AI 任务包含提示词版本、实际调用模型及来源转录版本。',{jobId:id},({jobId})=>request(`/api/jobs/${enc(jobId)}`),true);
  tool('update_topic','更正主题标题、摘要或父主题。人工改动保留，AI 不静默覆盖。',{...mid,topicId:id,title:z.string().min(1).max(300).optional(),summary:z.string().max(12000).optional(),parentId:id.nullable().optional()},({meetingId,topicId,...input})=>request(`/api/meetings/${enc(meetingId)}/topics/${enc(topicId)}`,'PATCH',input));
  tool('create_topic','创建主题；传 entryIds 可将已有讨论条目拆分到新主题，保持原文引用。',{...mid,title:z.string().min(1).max(300),parentId:id.optional(),entryIds:z.array(id).optional()},({meetingId,...input})=>request(`/api/meetings/${enc(meetingId)}/topics`,'POST',input));
  tool('merge_topics','将 sourceTopicId 合并到 targetTopicId，保留条目、来源和旧主题指向。',{...mid,sourceTopicId:id,targetTopicId:id},({meetingId,sourceTopicId,targetTopicId})=>request(`/api/meetings/${enc(meetingId)}/topics/${enc(sourceTopicId)}/merge`,'POST',{targetId:targetTopicId}));
  tool('update_discussion_entry','更正观点、待澄清问题、决定或行动项。保留修改历史和人工编辑字段。',{...mid,entryId:id,text:z.string().min(1).max(12000).optional(),type:z.enum(['viewpoint','question','decision','action']).optional(),status:z.enum(['active','open','resolved','superseded']).optional(),owner:z.string().max(200).optional(),due:z.string().max(200).optional()},({meetingId,entryId,...input})=>request(`/api/meetings/${enc(meetingId)}/entries/${enc(entryId)}`,'PATCH',{...input,author:'agent'}));
  tool('record_clarification','记下围绕某个问题的讨论。默认 outcome=recorded，只保存讨论记录，不表示问题已解决或形成共识；明确分类时可选择 clarified、needs_verification 或 difference_remains。text 写实际进展；evidenceIds 仅引用本次会议原文。建议填写读取时的 sourceRevision 和 transcriptEditRevision；仅追加发言可保存，原文或说话人修正后需重新核对。记录保留 Agent 作者身份，不改写转录。保存后用 get_meeting_context 回读。',{...mid,followupId:id,outcome:z.enum(['recorded','clarified','needs_verification','difference_remains']).default('recorded'),text:z.string().trim().min(1).max(6000),evidenceIds:z.array(id).max(50).optional(),sourceRevision:z.number().int().min(0).optional(),transcriptEditRevision:z.number().int().min(0).optional()},({meetingId,followupId,outcome,text,evidenceIds,sourceRevision,transcriptEditRevision})=>request(`/api/meetings/${enc(meetingId)}/followups/${enc(followupId)}`,'PATCH',{status:outcome==='recorded'?'recorded':'resolved',resolution:{outcome,text,...(evidenceIds?{evidenceIds}:{})},author:'agent',...(sourceRevision!==undefined?{sourceRevision}:{}),...(transcriptEditRevision!==undefined?{transcriptEditRevision}:{})}));
  tool('update_followup_presentation','修改澄清问题的简短问句或讨论价值说明，便于会中阅读。保留完整 question、rationale、impact 和原文引用；不改变讨论状态或产生新结论，人工文案不会被 AI 静默覆盖。',{...mid,followupId:id,shortQuestion:z.string().trim().min(1).max(200).optional(),discussionValue:z.string().trim().min(1).max(800).optional(),sourceRevision:z.number().int().min(0).optional(),transcriptEditRevision:z.number().int().min(0).optional()},({meetingId,followupId,...input})=>request(`/api/meetings/${enc(meetingId)}/followups/${enc(followupId)}`,'PATCH',{...input,author:'agent'}));
  tool('resolve_followup','兼容旧流程：将追问标记为已解决或忽略。resolved 仅改变状态，不说明得到什么结论；有具体澄清进展时请用 record_clarification。',{...mid,followupId:id,status:z.enum(['resolved','ignored'])},({meetingId,followupId,status})=>request(`/api/meetings/${enc(meetingId)}/followups/${enc(followupId)}`,'PATCH',{status,author:'agent'}));
  tool('get_artifact','读取指定类型产物的当前全文，包含来源版本。',{...mid,type:z.string().min(1).max(60)},async({meetingId,type})=>{
    const m=await request(`/api/meetings/${enc(meetingId)}`),a=m.artifacts.find(a=>a.type===type);
    if(!a)throw new Error('产物不存在');const {history,...current}=a;return current;
  },true);
  tool('save_artifact','将 Agent 产物写回本场会议，保留之前版本。产物不作为会议原始证据。',{...mid,type:z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),title:z.string().max(200),markdown:z.string().max(250000),sourceRevision:z.number().int().min(0)},({meetingId,type,...input})=>request(`/api/meetings/${enc(meetingId)}/artifacts/${enc(type)}`,'PUT',{...input,author:'agent'}));
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  await createMCPServer().connect(new StdioServerTransport());
}
