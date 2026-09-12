# Data and service contract

Meeting content is scoped to a meeting. Team members and team voiceprint profiles are shared within the same local installation. Server uses camelCase JSON. Credentials are stored separately from meeting data.

## Data

Meeting: id,title,goal,status(planned|active|ended),source(recording_import optional),importJobId(optional),archived,createdAt,updatedAt,transcriptRevision,transcriptEditRevision,contentRevision,processedRevision,processedThroughMs,autoOrganize,focusFollowupId(optional ID|null),focusSourceRevision(optional),topics,followups,questions,artifacts,speakerLabels,participants[],identityRevision.
Topic: id,parentId(null for root),title,summary,summaryEvidenceIds[],sourceRevision,entries[],manualFields[],mergedInto(optional),history[]. Summary history stores {summary,evidenceIds[],sourceRevision,changedAt}. Omitting summary preserves the current version; accepted changes retain its previous text and sources.
Entry: id,type(viewpoint|question|decision|action),text,speakerId(optional),participantIds[](optional),evidenceIds[],status(active|open|resolved|superseded),owner(optional),due(optional),author(ai|host|agent),manualFields[],history[].
Followup (clarification focus): id,topicId,kind(concept|assumption|criteria|other),question,shortQuestion(optional),discussionValue(optional),rationale,impact,evidenceIds[],status(active|ignored|recorded|resolved|merged),mergedInto(optional),mergedFrom(optional array of IDs),sourceRevision,presentationSourceRevision(optional),stale,pendingReview,author,manualFields[],history[]. Existing AI questions can evolve under the same ID. Merging preserves the source item and its history; merged items do not remain independent active questions. Legacy followups may omit kind/impact. Optional presentation fields do not replace the full question or its evidence.
Resolution: followup.resolution = {outcome(recorded|clarified|needs_verification|difference_remains),text,complete(optional boolean for legacy/host records),evidenceIds[],evidence[],author(ai|host|agent),sourceRevision,updatedAt,stale,pendingReview}. New AI resolutions require complete: false keeps the question active with partial progress; true marks it resolved because the core question no longer needs current discussion. Outcome describes the nature of the progress, not completion or consensus. The default host recorded outcome preserves a note and leaves the question unresolved. Legacy state-only resolved items have no inferred resolution.
QuestionAnswer: id,question,answer,inference,evidenceIds[],topicId(optional),sourceRevision,stale.
Artifact: id,type,title,markdown,sourceRevision,author,updatedAt,stale.
Transcript: id,meetingId,recordingId(optional),text,speakerId,participantId,startSample,endSample,startMs,endMs,revision,origin(asr|host|agent),timing(chunk optional),createdAt. startMs/endMs are meeting timeline coordinates; sample coordinates locate one recording. timing=chunk means approximate file-ASR chunk alignment, not sentence timing.
Recording: id,meetingId,sampleCount,sampleRate(16000),startedAt,endedAt,state(recording|paused|stopped|interrupted),gaps[],timelineStartMs.
Capture public state: connected,state(idle|recording|paused|interrupted),recordingId,asrState(unconfigured|connecting|connected|reconnecting|error|stopped),error.
Job: id,meetingId,type(import|organize|followup|answer|minutes|refresh_speakers),status(queued|running|done|error|cancelled),input,result,error,createdAt,updatedAt. AI jobs add promptVersion,model,sourceRevision,modelCalls[]. model=null and an empty calls list mean no actual call was attempted. Import jobs have input.chunkSamples, input.asrPlan (provider and non-secret request configuration) and progress{phase,completedChunks,totalChunks,processedSeconds,totalSeconds}; progress measures saved results, not upstream recognition progress.
Command: id,meetingId,action(start|pause|resume|stop|end),status(pending|needs_user_action|running|done|error),result,error.

## 说话人身份与本地声纹

`speakerId` 保留 ASR 的原始分组标识，不作为跨录音或跨会议身份。`participantId` 指向本场会议的稳定说话人；`memberId` 可关联同一本地安装中的团队成员。Participant 包含 `id,name,memberId,speakerIds[]`，合并时保留 `mergedInto`。同一成员可关联多个说话人分组，不会仅因名字相同就自动合并；没有团队关联的访客仅属于本场会议。

AI 的来源视图提供 `participantId`、`displayName`，已关联成员时也提供 `memberId`。相同的非空 `memberId` 表示已确认是同一人。AI 正文通过精确标记 `[[person:participantId]]` 保存身份引用，展示和导出时解析为最新姓名；不对普通姓名、原文引句或人工正文做全局字符串替换。Entry 的 `participantIds` 表示有来源支持的观点归属，不能直接取全部引用发言人的合集。

`refreshSpeakers(meetingId, sourceIds, {kind})` 返回 `refresh_speakers` 任务，或在无需核对时返回 `null`。`kind:'labels'` 仅迁移受影响的旧 AI 自由文本，已结构化的内容直接显示新姓名；`kind:'attribution'` 用于成员关联变化、说话人合并和发言归属修正，核对关联的主题、澄清、回答与产物。任务保留原 ID 和人工内容，全部通过来源与身份校验后才写回；失败保留原内容，已结束会议也可核对。

声音样本及候选比对由独立本地任务处理。新转录到来后，后台只识别未命名的 ASR 分组；至少两段合格发言满足自动采用条件时关联团队成员，否则保留候选。身份确认后复用，人工改名优先；重连分组重新核对，访客候选由主持人确认。自动匹配不登记新样本。团队样本作用于同一本地安装的不同会议，访客样本仅作用于登记会议。安装、样本要求和未校准边界见 [本地声纹说明](VOICEPRINT_RUNTIME.md)。

## HTTP API (JSON)

GET /api/health
GET /api/settings -> {llm:{baseUrl,model,reasoningEffort,configured},asr:{configured,resourceId},fileAsr:{provider,resourceId,baseUrl,model,language,configured}}. PUT accepts the corresponding provider settings and credentials; blank secrets preserve prior values. Fresh installations default file ASR to Volcengine, sharing live-ASR credentials with a separate file resource ID; the OpenAI-compatible alternative retains its own settings.
GET /api/meetings?archived=1 -> {meetings:[]}; POST {title,goal} -> Meeting
GET /api/meetings?limit=20&cursor=...&archived=1 -> {meetings:[],nextCursor,hasMore}; pagination reads summaries only, ordered by createdAt/id descending. The opaque cursor is used only for the same archive scope. Omitting limit/cursor retains the full legacy list for Agent clients.
POST /api/meetings/import (multipart file,title?,goal?) -> 202 {meeting,job}; creates an ended meeting only after full local upload, then decodes and transcribes asynchronously.
POST /api/meetings/:id/import/retry -> Job; resumes failed import checkpoints, returns the existing job for running/done tasks.
GET /api/meetings/:id -> Meeting plus recordings[],jobs[],commands[],capture
PATCH /api/meetings/:id -> Meeting (title,goal,archived,autoOrganize,speakerLabels)
GET /api/meetings/:id/transcript?cursor=0&limit=100&q=... -> {lines,total,nextCursor}
POST /api/meetings/:id/transcript {text,speakerId?,startMs?,endMs?} -> Transcript (manual note counts as source, visibly marked)
PATCH /api/meetings/:id/transcript/:lineId {text,speakerId} -> Transcript
PATCH /api/meetings/:id/topics/:topicId {title,summary,parentId} -> Meeting
POST /api/meetings/:id/topics {title,parentId?,entryIds?} -> Meeting (new/split topic)
POST /api/meetings/:id/topics/:topicId/merge {targetId} -> Meeting
PATCH /api/meetings/:id/entries/:entryId {text,type,status,owner,due} -> Meeting
PATCH /api/meetings/:id/followups/:followupId {status?:ignored|recorded|resolved,shortQuestion?,discussionValue?,author?,sourceRevision?,transcriptEditRevision?,resolution?:{outcome:recorded|clarified|needs_verification|difference_remains,text,evidenceIds?}} -> Meeting. Use the sourceRevision and transcriptEditRevision read before editing: appends permit saving with the original sourceRevision; a changed edit revision returns 409. An older sourceRevision without an edit revision also requires re-reading. Evidence is checked against the meeting. Human/Agent notes without evidence are allowed with explicit provenance; never appended to transcript. Presentation-only updates preserve existing artifact validity.
POST /api/meetings/:id/jobs {type,question?,topicId?,force?} -> Job; GET /api/jobs/:id -> Job. organize + force=true rereads all finalized transcript, preserving stable IDs, human changes and clarification history, then reviews remaining open/pending AI questions. Ordinary organize remains incremental.
POST /api/meetings/:id/commands {action} -> Command; GET /api/commands/:id -> Command
PUT /api/meetings/:id/artifacts/:type {title,markdown,author?,sourceRevision?} -> Artifact
GET /api/meetings/:id/export -> Markdown download
GET /api/recordings/:id/audio?startSample=0&endSample=... -> WAV

Frontend polls selected meeting and transcript every 2 seconds; organized auto jobs are scheduled server-side while capture is recording. No frontend auto-job scheduler.

The focus view follows focusFollowupId by default. Explicit null means quiet; only legacy meetings without this field fall back to the first active item. If a non-null recommendation still points to a resolved/ignored item after a host action, the client continues to another valid active item, preferring the same topic and then subsequent queue order. Stale/missing recommendations do not trigger this fallback. Choosing another question or opening evidence holds the reading position until “回到当前”. Inline editing and the progress editor temporarily pause following and restore the prior mode on close. Merged IDs resolve to their target.

Topic details show up to five current entries by default, except all current decisions/actions remain visible even above that limit. Other current entries expand on demand. Answered questions, superseded/stale entries and previous summaries are available in discussion history with their source links.

## Store interface (synchronous)

getMeeting(id),listMeetings({archived=false}),createMeeting(input),updateMeeting(id,patch),mutateMeeting(id,fn) (fn mutates clone; persist atomically; contentRevision increments).
getTranscript(id,{cursor=0,limit=100,q}={}) -> {lines,total,nextCursor}; allTranscript(id) -> lines[]; appendTranscript(id,line) -> line (increments transcriptRevision); editTranscript(id,lineId,patch) -> line.
createJob(meetingId,type,input),getJob(id),updateJob(id,patch),listJobs(meetingId?),pendingJobs().
createCommand(meetingId,action),getCommand(id),updateCommand(id,patch),listCommands(meetingId).
createRecording(meetingId,{timelineStartMs=0}={}),getRecording(id),updateRecording(id,patch),listRecordings(meetingId).
getSettings() (server-only resolved secrets),saveSettings(input),publicSettings(); dataDir property; recordings use store.dataDir/audio/{recordingId}.pcm.
saveArtifact(meetingId,type,input),close(). All get methods throw status=404 when missing.

## AI service

export createAIService({store}) from server/ai/service.js -> {submit(meetingId,type,input={}): Job, refreshSpeakers(meetingId,sourceIds,{kind='attribution'}={}): Job|null, start(), stop()}. Uses store interface above; jobs serial per meeting; persists/restores queue; server-side timer schedules organize only for recording meetings with autoOrganize true and changed finalized transcript. Root sets meeting.capture state during capture updates. LLM via fetch OpenAI-compatible chat/completions with store.getSettings().llm. AI owns reducer, prompting, retrieval and focused tests.

Model JSON must match the operation's basic structure before applying results: organization has topics/followups arrays; answers have answer text and evidence array. Invalid objects (including echoed input) fail the job without advancing the source watermark. Empty arrays are valid. Citation and ownership validation remain separate from this structural check.

Organization uses stable entry IDs to update an ongoing issue; supersedes can consolidate ordinary entries as well as replace explicit decisions, with source/history retention and manual-field protection. Summary updates use summaryEvidence for the whole current summary. Incremental source assembly adds existing conclusion evidence, issue-specific retrieval and nearby replies instead of repeating only the original question citations.

Before producing minutes, and after forced reanalysis, the service reviews eligible active or pending AI questions in bounded groups. Review can record partial/full answers, evolve or merge questions and update the recommendation; followupLimit=0 prevents new questions. Host/Agent records and ignored items are protected. Retrieval is bounded, so missing evidence is not proof that no answer exists; these mechanics do not establish real-meeting quality without evaluation.

## Capture modules

export createCaptureService({server,store,onEnded}) from server/capture/service.js -> {request(meetingId,action):Command,getState(meetingId):CaptureState,close()}.
Capture owns /ws/capture handling, recording .pcm files and ASR adapter. onEnded(meetingId) root sets meeting ended and schedules minutes after organizing. Root serves WAV endpoint using exported helper if available; otherwise service provides readAudio(recordingId,{startSample,endSample}) -> Buffer.
export CaptureClient from src/lib/capture-client.js: constructor({meetingId,onState,onPartial,onError,onCommand}); connect(); disconnect(); startFromGesture(commandId,audioSource) where audioSource is microphone|meeting; request(action) -> POST command; executeCommand(commandId) for authorization button; pause/resume/stop commands auto execute on connected browser. Public methods may extend but coordinate with frontend owner. Start requiring gesture emits onCommand(command with needs_user_action). Root HTTP control invokes same service. Capture agent must message frontend agent exact API.

## Recording import

createImportService({store,ai}) from server/import/service.js exposes receive(req),retry(meetingId),start(),stop(). stop() is awaited before store.close(). A separate serial worker handles only type=import; AI workers ignore those jobs.

Uploads are streamed to imports/{uploadId}/original.*, limited to 512 MiB. ffmpeg decodes to mono 16 kHz s16 PCM with local file protocols and audio/container format allowlists; decoded output is capped at 2 GiB. The original is retained on failure. Fresh installations default to Volcengine file ASR at /api/v3/auc/bigmodel/recognize/flash with base64 WAV data, shared realtime-ASR credentials and a separate file resource ID. New Volcengine imports submit the entire recording within the 100,000,000-byte / 7,200-second limits; larger recordings use 49,999,978-sample chunks (about 52 minutes with the current WAV format). Speaker separation and utterance timestamps remain enabled. Both HTTP status and X-Api-Status-Code are checked. OpenAI-compatible file settings remain supported through /v1/audio/transcriptions, default to 60-second chunks and retain their separate credentials when switching providers.

Each new job persists its chunk size and non-secret provider settings. Restarts use that plan and current credentials. Explicit retry can refresh settings for the same provider without changing boundaries; retry with a different provider is rejected. Legacy jobs with decoded audio or checkpoints retain their original 60-second boundaries. Finished meetings are not retranscribed automatically.

Chunk results are durably saved before transcript writes, using stable IDs and a completion checkpoint, so resume cannot duplicate or overwrite host corrections. Valid timestamped results are not limited by total text length or sentence count; any single line exceeding the store's 20,000-character limit fails explicitly. Invalid/missing timestamps fall back to chunk positioning only when the complete text fits that limit. Transcript writes yield to the event loop every 50 lines. Unrecognized and pending intervals remain playable with explicit gaps. Speaker IDs are scoped to each request; matching local speaker numbers across requests does not establish identity.

Import completion returns result{recordingId,transcriptCount,durationMs,analysisJobId,analysisState,message}. analysisState is queued|not_configured|failed|no_transcript, and describes a separate minutes job when present. Capture remains idle throughout import. The meeting has autoOrganize=false; complete imports explicitly submit minutes when LLM is configured, avoiding analysis of incomplete chunks by the live timer.
