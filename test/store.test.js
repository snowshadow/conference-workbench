import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { addTopic,editTopic,mergeTopic,editEntry,editFollowup } from '../server/content.js';
import { reduceOrganization } from '../server/ai/reducer.js';
import { readingFocusId } from '../shared/discussion-view.js';

function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-store-test-')),store=new Store(dir);t.after(()=>store.close());return store;}
test('historical speaker validation errors explain preserved identity edits without rewriting stored history', t => {
  const store = fixture(t), meeting = store.createMeeting({ title: '历史核对记录' });
  const error = '发言人核对的原文依据不完整，原内容已保留，请重试。';
  const job = store.createJob(meeting.id, 'refresh_speakers');
  store.updateJob(job.id, { status: 'error', error });
  const presented = store.getJob(job.id);
  assert.equal(presented.status, 'error');
  assert.match(presented.error, /核对结果未通过校验/);
  assert.match(presented.error, /已保存的姓名标记和原文不受影响/);
  assert.doesNotMatch(presented.error, /原文依据不完整|请重试|人物归属与引用/);
  assert.equal(store.listJobs(meeting.id)[0].error, presented.error);
  assert.equal(store.getRecord('jobs', job.id).error, error);
  const unrelated = store.createJob(meeting.id, 'organize');
  store.updateJob(unrelated.id, { status: 'error', error });
  assert.equal(store.getJob(unrelated.id).error, error);
  store.updateJob(job.id, { error: '模型服务连接失败' });
  assert.equal(store.getJob(job.id).error, '模型服务连接失败');
});
test('dismissing a manually selected question advances even from an AI quiet recommendation',t=>{
  const s=fixture(t),m=s.createMeeting({title:'先放下后继续'});
  s.mutateMeeting(m.id,d=>{
    d.focusFollowupId=null;
    d.followups=[
      {id:'earlier',topicId:'t',status:'active'},
      {id:'selected',topicId:'t',status:'active'},
      {id:'stale',topicId:'t',status:'active',stale:true},
      {id:'merged',topicId:'t',status:'active',mergedInto:'next'},
      {id:'finished',topicId:'t',status:'resolved'},
      {id:'other-topic',topicId:'other',status:'active'},
      {id:'next',topicId:'t',status:'active'},
    ];
  });
  assert.equal(readingFocusId(s.getMeeting(m.id),'selected',false),'selected');
  const updated=editFollowup(s,m.id,'selected',{status:'ignored'});
  assert.equal(updated.focusFollowupId,'next');
  assert.equal(readingFocusId(updated,'selected',true),'next');
  assert.equal(s.getMeeting(m.id).focusFollowupId,'next');
  assert.equal(updated.followups[1].status,'ignored');
  assert.equal(editFollowup(s,m.id,'next',{status:'ignored'}).focusFollowupId,'earlier');
  assert.equal(editFollowup(s,m.id,'earlier',{status:'ignored'}).focusFollowupId,'other-topic');
  assert.equal(editFollowup(s,m.id,'other-topic',{status:'ignored'}).focusFollowupId,null);
});
test('failed and repeated dismissals do not move the current focus',t=>{
  const s=fixture(t),m=s.createMeeting({title:'保留阅读位置'});
  s.mutateMeeting(m.id,d=>{d.focusFollowupId='first';d.followups=[{id:'first',status:'active'},{id:'second',status:'active'}];});
  assert.throws(()=>editFollowup(s,m.id,'first',{status:'ignored',sourceRevision:1}),/来源版本无效/);
  assert.equal(s.getMeeting(m.id).focusFollowupId,'first');
  assert.equal(s.getMeeting(m.id).followups[0].status,'active');
  editFollowup(s,m.id,'first',{status:'ignored'});
  s.mutateMeeting(m.id,d=>{d.focusFollowupId=null;});
  assert.equal(editFollowup(s,m.id,'first',{status:'ignored'}).focusFollowupId,null);
  s.mutateMeeting(m.id,d=>{d.followups[1].stale=true;});
  assert.equal(editFollowup(s,m.id,'second',{status:'ignored'}).focusFollowupId,null);
});
test('clarification outcomes preserve uncertainty, authorship and revisions without becoming transcript facts',t=>{
  const s=fixture(t),m=s.createMeeting({title:'实时同步的含义'}),line=s.appendTranscript(m.id,{text:'打开时最新就可以；后台告警才需要立即同步。',speakerId:'a'});
  s.mutateMeeting(m.id,d=>{d.followups=[{id:'focus',kind:'concept',question:'哪些场景需要立即同步？',rationale:'实时可能有不同含义',impact:'影响同步架构',evidenceIds:[line.id],status:'active',author:'ai'}];});
  s.saveArtifact(m.id,'minutes',{markdown:'原纪要',author:'ai',sourceRevision:1});
  const before=s.allTranscript(m.id);
  editFollowup(s,m.id,'focus',{status:'resolved',sourceRevision:1,resolution:{outcome:'needs_verification',text:'还需验证后台告警的实际时延要求。',evidenceIds:[line.id]}});
  let item=s.getMeeting(m.id).followups[0];
  assert.equal(item.resolution.author,'host');assert.equal(item.resolution.outcome,'needs_verification');assert.equal(item.resolution.evidence[0].quote,line.text);assert.equal(item.resolution.sourceRevision,1);
  assert.ok(s.getMeeting(m.id).artifacts[0].stale);assert.deepEqual(s.allTranscript(m.id),before);
  editFollowup(s,m.id,'focus',{status:'resolved',author:'agent',resolution:{outcome:'difference_remains',text:'上线速度和告警时效仍需取舍。'}});
  item=s.getMeeting(m.id).followups[0];assert.equal(item.resolution.author,'agent');assert.equal(item.history.at(-1).resolution.outcome,'needs_verification');assert.deepEqual(item.resolution.evidenceIds,[]);
  assert.equal(item.resolution.stale,false);assert.deepEqual(s.allTranscript(m.id),before);
});
test('clarification writes reject fabricated/cross-meeting sources and stale source versions; source edits invalidate results',t=>{
  const s=fixture(t),m=s.createMeeting({title:'前提核对'}),other=s.createMeeting({title:'其他会议'});
  const line=s.appendTranscript(m.id,{text:'我们还没有验证并发量。',speakerId:'a'}),foreign=s.appendTranscript(other.id,{text:'外场发言'});
  s.mutateMeeting(m.id,d=>{d.followups=[{id:'f',kind:'assumption',question:'并发量是否验证？',evidenceIds:[line.id],status:'active',author:'ai'}];});
  const input={status:'resolved',sourceRevision:1,resolution:{outcome:'needs_verification',text:'并发量待验证。',evidenceIds:[foreign.id]}};
  assert.throws(()=>editFollowup(s,m.id,'f',input),/本次会议/);
  assert.throws(()=>editFollowup(s,m.id,'f',{...input,resolution:{...input.resolution,evidenceIds:['fabricated']}}),/本次会议/);
  assert.throws(()=>editFollowup(s,m.id,'f',{...input,resolution:{outcome:'consensus',text:'全部同意'}}),/请选择这个问题当前的讨论结果/);
  assert.equal(s.getMeeting(m.id).followups[0].status,'active');
  editFollowup(s,m.id,'f',{...input,resolution:{...input.resolution,evidenceIds:[line.id]}});
  s.editTranscript(m.id,line.id,{text:'并发量已核对为十个请求。'});
  let item=s.getMeeting(m.id).followups[0];assert.equal(item.resolution.stale,true);assert.equal(item.resolution.text,'并发量待验证。');assert.equal(item.resolution.evidence[0].quote,line.text);
  assert.throws(()=>editFollowup(s,m.id,'f',{...input,resolution:{...input.resolution,evidenceIds:[line.id]}}),error=>error.status===409);
  editFollowup(s,m.id,'f',{status:'resolved',sourceRevision:2,resolution:{outcome:'clarified',text:'核对并发量为十个请求。',evidenceIds:[line.id]}});
  s.updateMeeting(m.id,{speakerLabels:{a:'已核对的说话人'}});
  item=s.getMeeting(m.id).followups[0];assert.equal(item.resolution.stale,false,'adding a name keeps the verified result current');
});
test('legacy resolved status remains a state marker and never invents a clarification outcome',t=>{
  const s=fixture(t),m=s.createMeeting({title:'兼容旧追问'});
  s.mutateMeeting(m.id,d=>{d.followups=[{id:'legacy',question:'旧问题',status:'active'}];});
  editFollowup(s,m.id,'legacy',{status:'resolved'});
  assert.equal(s.getMeeting(m.id).followups[0].resolution,undefined);
});
test('recording a clarification tolerates ongoing speech but rejects concurrent source edits',t=>{
  const s=fixture(t),m=s.createMeeting({title:'持续发言中的主持人记录'});
  const line=s.appendTranscript(m.id,{text:'告警必须及时看到。',speakerId:'a'});
  s.mutateMeeting(m.id,d=>{d.followups=[{id:'f',kind:'concept',question:'及时是多久？',status:'active',evidenceIds:[line.id]}];});
  const input={status:'resolved',sourceRevision:1,transcriptEditRevision:0,resolution:{outcome:'needs_verification',text:'告警具体时延仍待验证。',evidenceIds:[line.id]}};
  s.appendTranscript(m.id,{text:'接下来讨论报表。'});
  const waiting=s.getMeeting(m.id).followups[0];assert.equal(waiting.pendingReview,true);assert.notEqual(waiting.stale,true,'ongoing speech keeps the current clarification visible');
  editFollowup(s,m.id,'f',input);
  const resolution=s.getMeeting(m.id).followups[0].resolution;
  assert.equal(resolution.sourceRevision,1);assert.equal(resolution.stale,false);assert.equal(s.getMeeting(m.id).transcriptRevision,2);
  s.editTranscript(m.id,line.id,{text:'告警可以稍后看到。'});
  assert.throws(()=>editFollowup(s,m.id,'f',input),error=>error.status===409);
});
test('late ASR revisions cannot overwrite host or Agent transcript corrections',t=>{
  const s=fixture(t),m=s.createMeeting({title:'转录修正'});
  for (const origin of ['host','agent']) {
    const original=s.appendTranscript(m.id,{text:'识别原文',speakerId:'1',origin:'asr'});
    const corrected=s.editTranscript(m.id,original.id,{text:'人工核对内容',speakerId:'named',origin});
    const revision=s.getMeeting(m.id).transcriptRevision;
    const delayed=s.appendTranscript(m.id,{id:original.id,text:'迟到识别内容',speakerId:'2'});
    assert.deepEqual(delayed,corrected);
    assert.equal(s.getMeeting(m.id).transcriptRevision,revision);
    assert.deepEqual(s.editTranscript(m.id,original.id,{text:'另一段迟到识别',origin:'asr'}),corrected);
  }
});
test('transcript corrections invalidate dependent evidence and retain manual provenance; appends preserve editorial revision',t=>{
  const s=fixture(t),m=s.createMeeting({title:'技术方案讨论'}),line=s.appendTranscript(m.id,{text:'我们决定先做 A。',origin:'asr'});
  assert.equal(s.getMeeting(m.id).contentRevision,0);
  s.mutateMeeting(m.id,d=>{d.topics=[{id:'t1',title:'选型',entries:[{id:'e1',type:'decision',text:'选择 A',status:'active',evidenceIds:[line.id]}]}];d.followups=[{id:'f1',status:'active'}];d.questions=[{id:'q1',evidenceIds:[line.id]}];d.processedRevision=1;});
  const updated=s.editTranscript(m.id,line.id,{text:'我们还没决定是否做 A。'});
  assert.equal(updated.origin,'host');assert.equal(updated.history[0].text,'我们决定先做 A。');
  const d=s.getMeeting(m.id);assert.equal(d.transcriptEditRevision,1);assert.equal(d.processedRevision,0);assert.ok(d.topics[0].entries[0].stale);assert.ok(d.questions[0].stale);
  const revision=d.contentRevision;s.updateMeeting(m.id,{capture:{state:'recording'}});assert.equal(s.getMeeting(m.id).contentRevision,revision);
  editEntry(s,m.id,'e1',{text:'仍未决定是否做 A',type:'question',status:'open'});
  const corrected=s.getMeeting(m.id).topics[0].entries[0];assert.equal(corrected.stale,false);assert.equal(corrected.evidence[0].quote,updated.text);assert.equal(corrected.sourceRevision,2);
  assert.equal(s.getMeeting(m.id).topics[0].stale,true);
  editTopic(s,m.id,'t1',{summary:'主持人核对后确认尚未决定'});
  assert.equal(s.getMeeting(m.id).topics[0].stale,false);
});
test('adding or changing speaker names preserves discussion, provenance and analysis progress',t=>{
  const s=fixture(t),m=s.createMeeting({title:'补上说话人姓名'});
  const line=s.appendTranscript(m.id,{text:'我担心离线能力。',speakerId:'speaker-5',endMs:12000});
  s.mutateMeeting(m.id,d=>{
    d.processedRevision=d.transcriptRevision;d.processedThroughMs=line.endMs;d.focusFollowupId='f1';
    d.topics=[{id:'t1',summary:'讨论离线能力',stale:false,entries:[{id:'e1',text:'speaker-5 担心离线能力',type:'viewpoint',status:'active',evidenceIds:[line.id],stale:false,author:'ai'}]}];
    d.questions=[{id:'q1',answer:'担心离线能力',evidenceIds:[line.id],stale:false}];
    d.followups=[{id:'f1',question:'离线能力是否已经验证？',evidenceIds:[line.id],status:'active',stale:false},
      {id:'f2',evidenceIds:[line.id],status:'recorded',stale:false,resolution:{text:'孙总的说法待验证',evidenceIds:[line.id],author:'host',stale:false}}];
  });
  s.saveArtifact(m.id,'minutes',{markdown:'原始记录：speaker-5 担心离线能力。',author:'host'});
  const transcript=s.allTranscript(m.id);
  for(const speakerLabels of [{'speaker-5':'孙总'},{'speaker-5':'孙先生'},{}]) {
    const before=s.getMeeting(m.id),after=s.updateMeeting(m.id,{speakerLabels});
    assert.deepEqual(after.speakerLabels,speakerLabels);
    assert.equal(after.contentRevision,before.contentRevision+1,'late AI results must not commit with an outdated name mapping');
    for(const key of ['transcriptRevision','transcriptEditRevision','processedRevision','processedThroughMs','focusFollowupId','topics','questions','followups','artifacts']) {
      assert.deepEqual(after[key],before[key],`${key} must survive a name change`);
    }
    assert.deepEqual(s.allTranscript(m.id),transcript,'names must not rewrite original speech or speaker assignments');
  }
});
test('saving unchanged speaker names does not invalidate an in-flight snapshot',t=>{
  const s=fixture(t),m=s.createMeeting({title:'保存相同姓名'});
  s.updateMeeting(m.id,{speakerLabels:{'speaker-5':'孙总','speaker-1':'李总'}});
  const before=s.getMeeting(m.id);
  const after=s.updateMeeting(m.id,{speakerLabels:{'speaker-1':'李总','speaker-5':'孙总'}});
  assert.equal(after.contentRevision,before.contentRevision,'mapping key order is not an editorial change');
  assert.equal(after.transcriptEditRevision,before.transcriptEditRevision);
});
test('renaming a speaker never revives conclusions invalidated by an actual transcript correction',t=>{
  const s=fixture(t),m=s.createMeeting({title:'先修原文再补名'});
  const line=s.appendTranscript(m.id,{text:'我们决定采用 A。',speakerId:'speaker-5'});
  s.mutateMeeting(m.id,d=>{
    d.processedRevision=d.transcriptRevision;
    d.topics=[{id:'t',entries:[{id:'e',text:'采用 A',evidenceIds:[line.id],status:'active',stale:false}]}];
    d.questions=[{id:'q',evidenceIds:[line.id],stale:false}];
    d.followups=[{id:'f',status:'recorded',evidenceIds:[line.id],stale:false,resolution:{text:'采用 A',evidenceIds:[line.id],stale:false}}];
  });
  s.saveArtifact(m.id,'minutes',{markdown:'采用 A',author:'ai'});
  s.editTranscript(m.id,line.id,{text:'我们还没决定采用 A。'});
  const corrected=s.getMeeting(m.id);
  assert.equal(corrected.topics[0].entries[0].stale,true);
  const renamed=s.updateMeeting(m.id,{speakerLabels:{'speaker-5':'孙总'}});
  for(const key of ['topics','questions','followups','artifacts','transcriptEditRevision','processedRevision']) assert.deepEqual(renamed[key],corrected[key]);
});
test('reassigning an actual utterance still invalidates linked discussion and preserves unrelated viewpoints',t=>{
  const s=fixture(t),m=s.createMeeting({title:'修正发言归属'});
  const first=s.appendTranscript(m.id,{text:'我担心离线能力。',speakerId:'speaker-5'}),other=s.appendTranscript(m.id,{text:'我来验证成本。',speakerId:'speaker-1'});
  s.updateMeeting(m.id,{speakerLabels:{'speaker-5':'孙总','speaker-1':'李总'}});
  s.mutateMeeting(m.id,d=>{d.processedRevision=d.transcriptRevision;d.topics=[
    {id:'a',title:'离线',stale:false,entries:[{id:'e1',evidenceIds:[first.id],stale:false}]},
    {id:'b',title:'成本',stale:false,entries:[{id:'e2',evidenceIds:[other.id],stale:false}]},
  ];d.questions=[{id:'q1',evidenceIds:[first.id],stale:false},{id:'q2',evidenceIds:[other.id],stale:false}];});
  const before=s.getMeeting(m.id),corrected=s.editTranscript(m.id,first.id,{speakerId:'speaker-1'}),after=s.getMeeting(m.id);
  assert.equal(corrected.speakerId,'speaker-1');assert.equal(corrected.history[0].speakerId,'speaker-5');
  assert.equal(corrected.text,first.text);
  assert.equal(after.transcriptRevision,before.transcriptRevision+1);assert.equal(after.transcriptEditRevision,before.transcriptEditRevision+1);
  assert.equal(after.processedRevision,0);
  assert.equal(after.topics[0].entries[0].stale,true);assert.equal(after.topics[1].entries[0].stale,false);
  assert.equal(after.questions[0].stale,true);assert.equal(after.questions[1].stale,false);
});

test('completed jobs retain historical text but expose corrected or replaced results as stale to Agent readers',t=>{
  const s=fixture(t),m=s.createMeeting({title:'历史任务状态'}),source=s.appendTranscript(m.id,{text:'我们决定采用 A。'});
  const answer={id:'qa1',question:'决定了什么？',answer:'采用 A',inference:'',evidenceIds:[source.id],sourceRevision:1,stale:false};
  s.mutateMeeting(m.id,d=>{d.questions=[answer];});
  const job=s.createJob(m.id,'answer',{question:answer.question});s.updateJob(job.id,{status:'done',result:answer});
  assert.equal(s.getJob(job.id).result.stale,false);
  s.editTranscript(m.id,source.id,{text:'还没决定采用什么。'});
  const reread=s.getJob(job.id);
  assert.equal(reread.result.answer,'采用 A');
  assert.equal(reread.result.stale,true);
  assert.equal(reread.result.hasNewerTranscript,true);
  assert.equal(s.listJobs(m.id)[0].result.stale,true);
  const artifact=s.saveArtifact(m.id,'minutes',{markdown:'第一份纪要',author:'ai'});
  const minutesJob=s.createJob(m.id,'minutes');s.updateJob(minutesJob.id,{status:'done',result:artifact});
  s.saveArtifact(m.id,'minutes',{markdown:'主持人改过的纪要',author:'host'});
  assert.equal(s.getJob(minutesJob.id).result.markdown,'第一份纪要');
  assert.equal(s.getJob(minutesJob.id).result.stale,true);
});
test('restart recovers PCM prefix and explicitly marks untranscribed tail',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-recovery-test-')),first=new Store(dir),m=first.createMeeting({title:'中断恢复'}),r=first.createRecording(m.id);
  fs.writeFileSync(path.join(dir,'audio',`${r.id}.pcm`),Buffer.alloc(3200));
  first.appendTranscript(m.id,{text:'已识别',recordingId:r.id,startSample:0,endSample:800});first.updateMeeting(m.id,{capture:{state:'recording',recordingId:r.id}});first.close();
  const reopened=new Store(dir);t.after(()=>reopened.close());const recovered=reopened.getRecording(r.id);
  assert.equal(recovered.state,'interrupted');assert.equal(recovered.sampleCount,1600);assert.equal(recovered.gaps[0].startSample,800);assert.equal(recovered.gaps[0].endSample,1600);assert.equal(reopened.getMeeting(m.id).capture.state,'interrupted');
});
test('split and merge preserve entry IDs/evidence and prevent cycles; archive is reversible',t=>{
  const s=fixture(t),m=s.createMeeting({title:'讨论'});
  s.mutateMeeting(m.id,d=>d.topics=[{id:'a',title:'A',entries:[{id:'e',text:'明确依据',type:'viewpoint',status:'active',evidenceIds:['line']}],manualFields:[]},{id:'b',title:'B',parentId:'a',entries:[],manualFields:[]}]);
  assert.throws(()=>editTopic(s,m.id,'a',{parentId:'b'}),/循环/);
  assert.equal(s.getMeeting(m.id).topics[0].parentId,undefined,'failed edit does not persist');
  const split=addTopic(s,m.id,{title:'拆分',entryIds:['e']});const topic=split.topics.at(-1);
  assert.equal(topic.entries[0].id,'e');assert.deepEqual(topic.entries[0].evidenceIds,['line']);assert.ok(topic.entries[0].manualFields.includes('topicId'));
  editEntry(s,m.id,'e',{text:'人工澄清后的依据'});assert.equal(s.getMeeting(m.id).topics.at(-1).entries[0].history.length,1);
  const merged=mergeTopic(s,m.id,topic.id,'b');assert.equal(merged.topics.find(t=>t.id===topic.id).mergedInto,'b');assert.equal(merged.topics.find(t=>t.id==='b').entries[0].id,'e');
  s.updateMeeting(m.id,{archived:true});assert.equal(s.listMeetings().length,0);assert.equal(s.listMeetings({archived:true}).length,1);s.updateMeeting(m.id,{archived:false});assert.equal(s.listMeetings().length,1);
});
test('host merge locks moved entry locations and reparented children against subsequent AI restructuring',t=>{
  const s=fixture(t),m=s.createMeeting({title:'人工合并'}),line=s.appendTranscript(m.id,{text:'讨论延迟与成本。'});
  s.mutateMeeting(m.id,d=>{d.topics=[
    {id:'a',title:'延迟',parentId:null,entries:[{id:'e',text:'讨论延迟',type:'viewpoint',status:'active',evidenceIds:[line.id],author:'ai',manualFields:[]}],manualFields:[]},
    {id:'b',title:'方案',parentId:null,entries:[],manualFields:[]},
    {id:'c',title:'成本',parentId:'a',entries:[],manualFields:[]},
  ];});
  const merged=mergeTopic(s,m.id,'a','b');
  assert.ok(merged.topics.find(t=>t.id==='b').entries[0].manualFields.includes('topicId'));
  assert.ok(merged.topics.find(t=>t.id==='c').manualFields.includes('parentId'));
  assert.equal(merged.topics.find(t=>t.id==='c').parentId,'b');
  const rewritten=reduceOrganization(merged,{topics:[
    {id:'new_split',title:'重新拆分',entries:[{id:'e',text:'讨论延迟',type:'viewpoint',evidence:[{id:line.id,quote:line.text}]}]},
    {id:'c',title:'成本',parentId:null,entries:[]},
  ]},[line]);
  assert.ok(rewritten.topics.find(t=>t.id==='b').entries.some(e=>e.id==='e'));
  assert.equal(rewritten.topics.find(t=>t.id==='c').parentId,'b');
});
test('meeting isolation, secret redaction, artifact history and source watermark survive restart',t=>{
  const s=fixture(t),m=s.createMeeting({title:'会议 A'}),other=s.createMeeting({title:'会议 B'});
  const recording=s.createRecording(other.id);assert.throws(()=>s.appendTranscript(m.id,{text:'错误归属',recordingId:recording.id}),/不属于/);
  const line=s.appendTranscript(m.id,{text:'事实',origin:'host'});assert.throws(()=>s.editTranscript(other.id,line.id,{text:'侵入'}),/不存在/);
  s.saveSettings({llm:{apiKey:'test-secret',baseUrl:'http://127.0.0.1:12345',model:'fixture'}});assert.ok(!JSON.stringify(s.publicSettings()).includes('test-secret'));
  s.saveSettings({llm:{apiKey:''}});assert.equal(s.getSettings().llm.apiKey,'test-secret');
  s.saveArtifact(m.id,'minutes',{markdown:'初稿',sourceRevision:1,author:'ai'});s.saveArtifact(m.id,'minutes',{markdown:'修正版',sourceRevision:1,author:'host'});
  const artifact=s.getMeeting(m.id).artifacts[0];assert.equal(artifact.history[0].markdown,'初稿');assert.equal(artifact.markdown,'修正版');
  s.appendTranscript(m.id,{text:'新的发言'});assert.ok(s.getMeeting(m.id).artifacts[0].stale);
});
