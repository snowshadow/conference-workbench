import crypto from 'node:crypto';
import { fail } from './store.js';
import { isActiveFocus, nextFocusId, recommendedFocusId } from '../shared/discussion-view.js';

const string = (value,max=12000) => String(value ?? '').trim().slice(0,max);
const findTopic = (meeting,id) => { const topic=meeting.topics.find(t=>t.id===id && !t.mergedInto); if(!topic) throw fail('主题不存在',404); return topic; };
const invalidateArtifacts = meeting => { for(const artifact of meeting.artifacts || []) {artifact.stale=true;artifact.staleReason='content_changed';} };
export function validateTree(topics) {
  const map=new Map(topics.filter(t=>!t.mergedInto).map(t=>[t.id,t]));
  for(const topic of map.values()) {
    const visited=new Set([topic.id]); let parent=topic.parentId;
    while(parent) { if(visited.has(parent)) throw fail('主题不能构成循环'); const ancestor=map.get(parent); if(!ancestor) throw fail('父主题不存在'); visited.add(parent); parent=ancestor.parentId; }
  }
}
export function editTopic(store,meetingId,topicId,patch) {
  return store.mutateMeeting(meetingId,m=>{
    const topic=findTopic(m,topicId), fields=new Set(topic.manualFields || []);
    if(Object.hasOwn(patch,'summary') && topic.summary && string(patch.summary)!==topic.summary) topic.history=[...(topic.history || []),{summary:topic.summary,evidenceIds:[...(topic.summaryEvidenceIds || [])],sourceRevision:topic.sourceRevision,changedAt:new Date().toISOString()}];
    for(const key of ['title','summary','parentId']) if(Object.hasOwn(patch,key)) { topic[key]=key==='parentId' ? (patch[key] || null) : string(patch[key],key==='title'?300:12000); fields.add(key); }
    if(!topic.title) throw fail('主题名称不能为空');
    if(Object.hasOwn(patch,'summary')) {topic.stale=false;topic.sourceRevision=m.transcriptRevision;}
    topic.manualFields=[...fields]; validateTree(m.topics);
    invalidateArtifacts(m);
  });
}
export function addTopic(store,meetingId,input) {
  return store.mutateMeeting(meetingId,m=>{
    const title=string(input.title,300); if(!title) throw fail('主题名称不能为空');
    const topic={id:crypto.randomUUID(),parentId:input.parentId || null,title,summary:'',entries:[],manualFields:['title','parentId']};
    if(input.parentId) findTopic(m,input.parentId);
    const selected=new Set(input.entryIds || []);
    const found=new Set();
    for(const existing of m.topics) {
      const moved=(existing.entries || []).filter(e=>selected.has(e.id));
      if(moved.length) existing.stale=true;
      for(const entry of moved) {found.add(entry.id);entry.manualFields=[...new Set([...(entry.manualFields||[]),'topicId'])];}
      topic.entries.push(...moved); existing.entries=(existing.entries || []).filter(e=>!selected.has(e.id));
    }
    if(found.size!==selected.size) throw fail('待拆分条目不存在');
    if(topic.entries.length) topic.stale=true;
    m.topics.push(topic); validateTree(m.topics); invalidateArtifacts(m);
  });
}
export function mergeTopic(store,meetingId,sourceId,targetId) {
  if(sourceId===targetId) throw fail('请选择另一个合并目标');
  return store.mutateMeeting(meetingId,m=>{
    const source=findTopic(m,sourceId),target=findTopic(m,targetId);
    // A child can receive its parent without creating a cycle: it inherits the parent's parent.
    let cursor=target; const seen=new Set();
    while(cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if(cursor.parentId===sourceId) {cursor.parentId=source.parentId || null;cursor.manualFields=[...new Set([...(cursor.manualFields||[]),'parentId'])];break;}
      cursor=m.topics.find(t=>t.id===cursor.parentId);
    }
    const ids=new Set(target.entries.map(e=>e.id));
    const moved=source.entries.filter(e=>!ids.has(e.id));
    for(const entry of moved) entry.manualFields=[...new Set([...(entry.manualFields || []),'topicId'])];
    target.entries.push(...moved);
    if(moved.length) target.stale=true;
    source.entries=[]; source.mergedInto=targetId;
    source.manualFields=[...new Set([...(source.manualFields || []),'mergedInto'])];
    for(const topic of m.topics) if(topic.parentId===sourceId) {topic.parentId=targetId;topic.manualFields=[...new Set([...(topic.manualFields || []),'parentId'])];}
    for(const item of [...m.followups,...m.questions]) if(item.topicId===sourceId) item.topicId=targetId;
    validateTree(m.topics); invalidateArtifacts(m);
  });
}
export function editEntry(store,meetingId,entryId,input) {
  return store.mutateMeeting(meetingId,m=>{
    const entry=m.topics.flatMap(t=>t.entries || []).find(e=>e.id===entryId);
    if(!entry) throw fail('讨论条目不存在',404);
    entry.history=[...(entry.history || []),{text:entry.text,type:entry.type,status:entry.status,owner:entry.owner,due:entry.due,evidenceIds:[...(entry.evidenceIds || [])],author:entry.author,updatedAt:new Date().toISOString()}];
    const fields=new Set(entry.manualFields || []);
    for(const key of ['text','type','status','owner','due']) if(Object.hasOwn(input,key)) {entry[key]=string(input[key]); fields.add(key);}
    if(!entry.text) throw fail('内容不能为空');
    if(!['viewpoint','question','decision','action'].includes(entry.type)) throw fail('条目类型无效');
    if(!['active','open','resolved','superseded'].includes(entry.status)) throw fail('条目状态无效');
    entry.author=input.author==='agent'?'agent':'host'; entry.manualFields=[...fields];
    if(Object.hasOwn(input,'text')) {
      const sources=new Map(store.allTranscript(meetingId).map(line=>[line.id,line]));
      entry.evidence=(entry.evidenceIds || []).filter(id=>sources.has(id)).map(id=>({id,quote:sources.get(id).text}));
      entry.sourceRevision=m.transcriptRevision;entry.stale=false;
    }
    const topic=m.topics.find(t=>(t.entries || []).some(item=>item.id===entryId));
    if(topic) topic.stale=true;
    invalidateArtifacts(m);
  });
}
export function editFollowup(store,meetingId,followupId,input) {
  const presentationFields=['shortQuestion','discussionValue'].filter(key=>Object.hasOwn(input,key));
  if(input.status!==undefined && !['ignored','recorded','resolved'].includes(input.status)) throw fail('澄清状态无效');
  if(input.status===undefined && !presentationFields.length) throw fail('请提供讨论状态或展示文案');
  if(input.resolution && !['recorded','resolved'].includes(input.status)) throw fail('讨论记录请使用 recorded 状态；明确结果请使用 resolved 状态');
  if(input.status==='recorded' && !input.resolution) throw fail('请填写讨论记录');
  for(const key of presentationFields) if(typeof input[key]!=='string' || !input[key].trim() || input[key].length>(key==='shortQuestion'?200:800)) throw fail(key==='shortQuestion'?'简短问题须为 1–200 字':'讨论价值须为 1–800 字');
  return store.mutateMeeting(meetingId,m=>{
    const f=m.followups.find(f=>f.id===followupId);if(!f)throw fail('澄清问题不存在',404);
    if(f.mergedInto) throw fail(`此问题已合并，请回读并修改保留的问题（${f.mergedInto}）。`,409);
    if(input.sourceRevision!==undefined) {
      if(!Number.isInteger(input.sourceRevision) || input.sourceRevision<0 || input.sourceRevision>m.transcriptRevision) throw fail('来源版本无效');
      if(input.sourceRevision<m.transcriptRevision && input.transcriptEditRevision===undefined) throw fail('原文已更新，请重新核对引用后保存。',409);
    }
    if(input.transcriptEditRevision!==undefined && (!Number.isInteger(input.transcriptEditRevision) || input.transcriptEditRevision<0)) throw fail('原文修订版本无效');
    if(input.transcriptEditRevision!==undefined && input.transcriptEditRevision!==(m.transcriptEditRevision || 0)) throw fail('原文或说话人已被修正，请重新核对引用后保存。',409);
    const author=input.author==='agent'?'agent':'host',updatedAt=new Date().toISOString();
    let resolution;
    if(input.resolution!==undefined) {
      const r=input.resolution;
      if(!r || typeof r!=='object' || Array.isArray(r) || !['recorded','clarified','needs_verification','difference_remains'].includes(r.outcome)) throw fail('请选择这个问题当前的讨论结果');
      if((r.outcome==='recorded')!==(input.status==='recorded')) throw fail('讨论记录使用 recorded 状态，明确结果使用 resolved 状态');
      if(typeof r.text!=='string' || !r.text.trim() || r.text.length>6000) throw fail('请填写 1–6000 字的讨论记录');
      const ids=r.evidenceIds ?? [];
      if(!Array.isArray(ids) || ids.length>50 || ids.some(id=>typeof id!=='string' || !id)) throw fail('原文引用格式无效');
      const byId=new Map(store.allTranscript(meetingId).map(line=>[line.id,line]));
      const evidenceIds=[...new Set(ids)];
      if(evidenceIds.some(id=>!byId.has(id))) throw fail('澄清引用必须来自本次会议原文');
      resolution={outcome:r.outcome,text:r.text.trim(),evidenceIds,evidence:evidenceIds.map(id=>({id,quote:byId.get(id).text,revision:byId.get(id).revision})),author,sourceRevision:input.sourceRevision ?? m.transcriptRevision,updatedAt,stale:false};
    }
    if(input.status==='resolved' && !resolution && f.resolution?.outcome==='recorded') throw fail('请填写明确结果后再标记为已解决');
    // Handling the current question moves focus without a model call. A note
    // remains unresolved; recording another question does not take over focus.
    if(input.status!==undefined && isActiveFocus(f) && (input.status==='ignored' || recommendedFocusId(m)===f.id)) m.focusFollowupId=nextFocusId(m,f.id);
    f.history=[...(f.history || []),{status:f.status,resolution:f.resolution ? structuredClone(f.resolution) : null,shortQuestion:f.shortQuestion,discussionValue:f.discussionValue,presentationSourceRevision:f.presentationSourceRevision,updatedAt:f.updatedAt || f.createdAt,updatedBy:f.updatedBy || f.author}];
    if(input.status!==undefined) f.status=input.status;
    f.updatedAt=updatedAt;f.updatedBy=author;
    f.manualFields=[...new Set([...(f.manualFields || []),...(input.status!==undefined?['status']:[]),...(resolution?['resolution']:[]),...presentationFields])];
    for(const key of presentationFields) f[key]=input[key].trim();
    if(presentationFields.length) f.presentationSourceRevision=input.sourceRevision ?? m.transcriptRevision;
    if(resolution) {f.resolution=resolution;f.sourceRevision=resolution.sourceRevision;f.stale=false;f.pendingReview=resolution.sourceRevision<m.transcriptRevision;}
    // A state-only legacy operation never invents a shared understanding.
    // Display wording is not an input to minutes. Keep the editorial revision guard
    // so an in-flight organizer cannot overwrite a manual presentation edit.
    if(input.status!==undefined || resolution) invalidateArtifacts(m);
  });
}
