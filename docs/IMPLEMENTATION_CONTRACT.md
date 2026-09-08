# Data and service contract

All data is scoped to a meeting. Server uses camelCase JSON. Credentials are stored separately from meeting data.

## Data

Meeting: id,title,goal,status(planned|active|ended),source(recording_import optional),importJobId(optional),archived,createdAt,updatedAt,transcriptRevision,transcriptEditRevision,contentRevision,processedRevision,processedThroughMs,autoOrganize,topics,followups,questions,artifacts,speakerLabels.
Topic: id,parentId(null for root),title,summary,entries[],manualFields[],mergedInto(optional).
Entry: id,type(viewpoint|question|decision|action),text,speakerId(optional),evidenceIds[],status(active|open|resolved|superseded),owner(optional),due(optional),author(ai|host|agent),manualFields[],history[].
Followup (clarification focus): id,topicId,kind(concept|assumption|criteria|other),question,shortQuestion(optional),discussionValue(optional),rationale,impact,evidenceIds[],status(active|ignored|recorded|resolved),sourceRevision,presentationSourceRevision(optional),stale,author,manualFields[],history[]. Legacy followups may omit kind/impact. Optional presentation fields do not replace the full question or its evidence.
Resolution: followup.resolution = {outcome(recorded|clarified|needs_verification|difference_remains),text,evidenceIds[],evidence[],author(ai|host|agent),sourceRevision,updatedAt,stale}. The default recorded outcome preserves a note and leaves the question unresolved; it does not establish a decision or agreement. Classified resolved outcomes are also not necessarily agreement or verified assumptions. Legacy state-only resolved items have no inferred resolution.
QuestionAnswer: id,question,answer,inference,evidenceIds[],topicId(optional),sourceRevision,stale.
Artifact: id,type,title,markdown,sourceRevision,author,updatedAt,stale.
Transcript: id,meetingId,recordingId(optional),text,speakerId,startSample,endSample,startMs,endMs,revision,origin(asr|host|agent),timing(chunk optional),createdAt. startMs/endMs are meeting timeline coordinates; sample coordinates locate one recording. timing=chunk means approximate file-ASR chunk alignment, not sentence timing.
Recording: id,meetingId,sampleCount,sampleRate(16000),startedAt,endedAt,state(recording|paused|stopped|interrupted),gaps[],timelineStartMs.
Capture public state: connected,state(idle|recording|paused|interrupted),recordingId,asrState(unconfigured|connecting|connected|reconnecting|error|stopped),error.
Job: id,meetingId,type(import|organize|followup|answer|minutes),status(queued|running|done|error|cancelled),input,result,error,createdAt,updatedAt. AI jobs add promptVersion,model,sourceRevision,modelCalls[]. model=null and an empty calls list mean no actual call was attempted. Import jobs have progress{phase,completedChunks,totalChunks,processedSeconds,totalSeconds}.
Command: id,meetingId,action(start|pause|resume|stop|end),status(pending|needs_user_action|running|done|error),result,error.

## HTTP API (JSON)

GET /api/health
GET /api/settings -> {llm:{baseUrl,model,configured},asr:{configured,resourceId},fileAsr:{baseUrl,model,language,configured}}. PUT same shape accepts apiKey,appKey,accessKey,baseUrl,model,resourceId,language; blank secret preserves prior value. File ASR is independent from live ASR, default local oMLX on port 8000.
GET /api/meetings?archived=1 -> {meetings:[]}; POST {title,goal} -> Meeting
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
POST /api/meetings/:id/jobs {type,question?,topicId?,force?} -> Job; GET /api/jobs/:id -> Job. organize + force=true rereads all finalized transcript, preserving stable IDs, human changes and clarification outcomes. Ordinary organize remains incremental.
POST /api/meetings/:id/commands {action} -> Command; GET /api/commands/:id -> Command
PUT /api/meetings/:id/artifacts/:type {title,markdown,author?,sourceRevision?} -> Artifact
GET /api/meetings/:id/export -> Markdown download
GET /api/recordings/:id/audio?startSample=0&endSample=... -> WAV

Frontend polls selected meeting and transcript every 2 seconds; organized auto jobs are scheduled server-side while capture is recording. No frontend auto-job scheduler.

## Store interface (synchronous)

getMeeting(id),listMeetings({archived=false}),createMeeting(input),updateMeeting(id,patch),mutateMeeting(id,fn) (fn mutates clone; persist atomically; contentRevision increments).
getTranscript(id,{cursor=0,limit=100,q}={}) -> {lines,total,nextCursor}; allTranscript(id) -> lines[]; appendTranscript(id,line) -> line (increments transcriptRevision); editTranscript(id,lineId,patch) -> line.
createJob(meetingId,type,input),getJob(id),updateJob(id,patch),listJobs(meetingId?),pendingJobs().
createCommand(meetingId,action),getCommand(id),updateCommand(id,patch),listCommands(meetingId).
createRecording(meetingId,{timelineStartMs=0}={}),getRecording(id),updateRecording(id,patch),listRecordings(meetingId).
getSettings() (server-only resolved secrets),saveSettings(input),publicSettings(); dataDir property; recordings use store.dataDir/audio/{recordingId}.pcm.
saveArtifact(meetingId,type,input),close(). All get methods throw status=404 when missing.

## AI service

export createAIService({store}) from server/ai/service.js -> {submit(meetingId,type,input={}): Job, start(), stop()}. Uses store interface above; jobs serial per meeting; persists/restores queue; server-side timer schedules organize only for recording meetings with autoOrganize true and changed finalized transcript. Root sets meeting.capture state during capture updates. LLM via fetch OpenAI-compatible chat/completions with store.getSettings().llm. AI owns reducer, prompting, retrieval and focused tests.

Model JSON must match the operation's basic structure before applying results: organization has topics/followups arrays; answers have answer text and evidence array. Invalid objects (including echoed input) fail the job without advancing the source watermark. Empty arrays are valid. Citation and ownership validation remain separate from this structural check.

## Capture modules

export createCaptureService({server,store,onEnded}) from server/capture/service.js -> {request(meetingId,action):Command,getState(meetingId):CaptureState,close()}.
Capture owns /ws/capture handling, recording .pcm files and ASR adapter. onEnded(meetingId) root sets meeting ended and schedules minutes after organizing. Root serves WAV endpoint using exported helper if available; otherwise service provides readAudio(recordingId,{startSample,endSample}) -> Buffer.
export CaptureClient from src/lib/capture-client.js: constructor({meetingId,onState,onPartial,onError,onCommand}); connect(); disconnect(); startFromGesture(commandId,audioSource) where audioSource is microphone|meeting; request(action) -> POST command; executeCommand(commandId) for authorization button; pause/resume/stop commands auto execute on connected browser. Public methods may extend but coordinate with frontend owner. Start requiring gesture emits onCommand(command with needs_user_action). Root HTTP control invokes same service. Capture agent must message frontend agent exact API.

## Recording import

createImportService({store,ai}) from server/import/service.js exposes receive(req),retry(meetingId),start(),stop(). stop() is awaited before store.close(). A separate serial worker handles only type=import; AI workers ignore those jobs.

Uploads are streamed to imports/{uploadId}/original.*, limited to 512 MiB. ffmpeg decodes to mono 16 kHz s16 PCM with local file protocols and audio/container format allowlists; decoded output is capped at 2 GiB. The original is retained on failure. Transcript requests use 60-second WAV chunks. Fresh installations default to Volcengine file ASR at /api/v3/auc/bigmodel/recognize/flash with base64 WAV data, shared realtime-ASR credentials and a separate file resource ID. Both HTTP status and X-Api-Status-Code are checked. Existing OpenAI-compatible file settings remain supported through /v1/audio/transcriptions and retain their separate credentials when switching providers. Chunk results are durably saved before transcript writes, using stable IDs and a completion checkpoint, so resume cannot duplicate or overwrite host corrections. Invalid/missing timestamps fall back to chunk positioning. Unrecognized and pending intervals remain playable with explicit gaps. Speaker IDs are scoped to each chunk.

Import completion returns result{recordingId,transcriptCount,durationMs,analysisJobId,analysisState,message}. analysisState is queued|not_configured|failed|no_transcript, and describes a separate minutes job when present. Capture remains idle throughout import. The meeting has autoOrganize=false; complete imports explicitly submit minutes when LLM is configured, avoiding analysis of incomplete chunks by the live timer.
