import { statSync } from 'node:fs';
import path from 'node:path';
import { fail } from './store.js';
import { resolveParticipant } from './people/store.js';
import { isVoiceprintTextEligible } from '../shared/voiceprint-policy.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function registerPeopleRoutes({ app, store, ai, voiceprints, automatic, detail }) {
  function withMeetingTitle(profile) {
    let meetingTitle = '';
    try { meetingTitle = store.getMeeting(profile.meetingId).title; } catch { /* The source may be unavailable. */ }
    return { ...profile, meetingTitle };
  }
  function refresh(meetingId, sourceIds, kind = 'attribution') {
    if (!sourceIds?.length) return null;
    try {
      return ai.refreshSpeakers ? ai.refreshSpeakers(meetingId, sourceIds, { kind }) : ai.submit(meetingId, 'refresh_speakers', { sourceIds, kind });
    } catch (error) {
      // Identity edits are durable even when the separately configured LLM is unavailable.
      return { status: 'error', error: error.message };
    }
  }
  function identityResult(meetingId, result) {
    const job = refresh(meetingId, result.affectedSourceIds);
    return { meeting: detail(meetingId), refreshJob: job };
  }
  app.get('/api/members', (req, res) => res.json({ members: store.listMembers() }));
  app.post('/api/members', (req, res) => res.status(201).json(store.createMember(req.body)));
  app.patch('/api/members/:memberId', (req, res) => {
    const member = store.updateMember(req.params.memberId, req.body);
    for (const meeting of store.listMeetings({ includeArchived: true })) {
      const participantIds = new Set((meeting.participants || []).filter(person => person.memberId === member.id && !person.mergedInto).map(person => person.id));
      if (participantIds.size) refresh(meeting.id, store.allTranscript(meeting.id).filter(line => participantIds.has(line.participantId)).map(line => line.id), 'labels');
    }
    res.json(member);
  });
  app.get('/api/meetings/:id/people', route(async (req, res) => {
    const participants = store.listParticipants(req.params.id);
    const lines = store.allTranscript(req.params.id);
    const profiles = (await voiceprints.listProfiles({ meetingId: req.params.id, includeUnavailable: true })).map(withMeetingTitle);
    res.json({ participants: participants.filter(person => !person.mergedInto).map(person => {
      const sources = lines.filter(line => line.participantId === person.id);
      const samples = sources.filter(line => isVoiceprintTextEligible(line.text) && line.recordingId && line.timing !== 'chunk' && Number.isSafeInteger(line.startSample) && Number.isSafeInteger(line.endSample) && line.endSample - line.startSample >= 48000)
        .sort((a, b) => (b.endSample - b.startSample) - (a.endSample - a.startSample)).slice(0, 8)
        .sort((a, b) => a.startMs - b.startMs)
        .map(({ id, text, recordingId, startSample, endSample, startMs }) => ({ id, text, recordingId, startSample, endSample: Math.min(endSample, startSample + 480000), startMs }));
      return { ...person, lineCount: sources.length, samples };
    }).filter(person => person.lineCount > 0 || person.name || person.identitySource === 'manual'), members: store.listMembers(), profiles, voiceprintJobs: voiceprints.listJobs?.({ meetingId: req.params.id, limit: 50 }) || [] });
  }));
  app.get('/api/meetings/:id/participants/:participantId/utterances', (req, res) => {
    const cursor = Number(req.query.cursor ?? 0), limit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('发言分页范围无效');
    const person = resolveParticipant(store.getMeeting(req.params.id), req.params.participantId);
    if (!person) throw fail('这位说话人不在本场会议中', 404);
    const sources = store.allTranscript(req.params.id).filter(line => line.participantId === person.id).sort((a, b) => a.startMs - b.startMs);
    const recordings = new Map();
    const lines = sources.slice(cursor, cursor + limit).map(line => {
      const { id, text, startMs, endMs, recordingId, startSample, endSample } = line;
      const result = { id, text, startMs, endMs, recordingId, startSample, endSample, playbackAvailable: false };
      // Replay includes short utterances; enrollment has its own stricter filter.
      if (!recordingId) return { ...result, playbackReason: '这段只有文字记录，没有对应录音。' };
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) || startSample < 0 || endSample <= startSample) return { ...result, playbackReason: '这段发言没有可用的录音位置。' };
      if (!recordings.has(recordingId)) {
        try {
          const recording = store.getRecording(recordingId);
          const file = statSync(path.join(store.dataDir, 'audio', `${recordingId}.pcm`));
          recordings.set(recordingId, { ...recording, savedSamples: file.isFile() ? Math.floor(file.size / 2) : 0 });
        } catch { recordings.set(recordingId, null); }
      }
      const recording = recordings.get(recordingId);
      if (!recording || recording.meetingId !== req.params.id || endSample > recording.sampleCount || endSample > recording.savedSamples) return { ...result, playbackReason: '这段录音暂时无法读取。' };
      if (endSample - startSample > 16000 * 3600) return { ...result, playbackReason: '这段录音超过一小时，请在“录音与原文”中分段回听。' };
      return { ...result, playbackAvailable: true, playbackLabel: line.timing === 'chunk' ? '回听所在录音段' : '回听' };
    });
    res.json({ lines, total: sources.length, nextCursor: cursor + limit < sources.length ? cursor + limit : null });
  });
  app.post('/api/meetings/:id/participants', (req, res) => res.status(201).json(store.createParticipant(req.params.id, req.body).participant));
  app.patch('/api/meetings/:id/participants/:participantId', (req, res) => {
    const previous = resolveParticipant(store.getMeeting(req.params.id), req.params.participantId);
    const result = store.updateParticipant(req.params.id, req.params.participantId, req.body);
    const current = resolveParticipant(result.meeting, req.params.participantId);
    const changedSources = result.affectedSourceIds?.length ? result.affectedSourceIds : store.allTranscript(req.params.id).filter(line => line.participantId === req.params.participantId).map(line => line.id);
    const kind = (previous?.memberId || null) !== (current?.memberId || null) ? 'attribution' : 'labels';
    const job = refresh(req.params.id, changedSources, kind);
    res.json({ meeting: detail(req.params.id), refreshJob: job });
  });
  app.post('/api/meetings/:id/participants/:participantId/merge', (req, res) => res.json(identityResult(req.params.id, store.mergeParticipants(req.params.id, req.params.participantId, req.body.targetId))));
  app.patch('/api/meetings/:id/transcript/:lineId/participant', (req, res) => {
    if (typeof req.body.participantId !== 'string' || !req.body.participantId) throw fail('请选择这段发言的说话人');
    res.json(identityResult(req.params.id, store.assignTranscriptParticipant(req.params.id, req.params.lineId, req.body.participantId, { author: req.body.author === 'agent' ? 'agent' : 'host' })));
  });
  app.get('/api/voiceprints/status', route(async (req, res) => res.json(await voiceprints.status())));
  app.get('/api/voiceprints/profiles', route(async (req, res) => res.json({ profiles: (await voiceprints.listProfiles({ includeUnavailable: true })).filter(profile => profile.scope === 'team').map(withMeetingTitle) })));
  app.patch('/api/voiceprints/profiles/:profileId', route(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') throw fail('请选择启用或停用声音样本');
    res.json({ profile: withMeetingTitle(await voiceprints.setProfileEnabled(req.params.profileId, req.body.enabled)) });
  }));
  app.post('/api/meetings/:id/participants/:participantId/recognition/retry', route(async (req, res) => {
    const recognition = await automatic.retry(req.params.id, req.params.participantId);
    res.status(202).json({ recognition });
  }));
  for (const type of ['enroll', 'match']) app.post(`/api/meetings/:id/participants/:participantId/voiceprints/${type}`, route(async (req, res) => {
    if ((type === 'enroll' || req.body.sourceIds !== undefined) && (!Array.isArray(req.body.sourceIds) || req.body.sourceIds.length < 2 || req.body.sourceIds.length > 4 || new Set(req.body.sourceIds).size !== req.body.sourceIds.length || req.body.sourceIds.some(id => typeof id !== 'string' || !id.trim()))) throw fail('请选择 2–4 段不同的发言片段');
    if (type === 'enroll' && !['meeting', 'team'].includes(req.body.scope)) throw fail('请选择仅用于本场会议或跨会议识别');
    const job = await voiceprints.submit(type, { meetingId: req.params.id, participantId: req.params.participantId, sourceIds: req.body.sourceIds, scope: req.body.scope });
    res.status(202).json({ job });
  }));
  app.get('/api/voiceprint-jobs/:id', route(async (req, res) => res.json({ job: await voiceprints.getJob(req.params.id) })));
  app.post('/api/voiceprint-jobs/:id/cancel', route(async (req, res) => res.json({ job: await voiceprints.cancelJob(req.params.id) })));
  return { refresh };
}
