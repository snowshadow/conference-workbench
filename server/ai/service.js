import { randomUUID } from 'node:crypto';
import { minutesDocumentMarkdown } from '../../shared/minutes-format.js';
import { reduceOrganization } from './reducer.js';
import { knownContext, supplementEvidence, reviewEvidence } from './context.js';
import { evidenceFor, retrieve, sourceLines, sourceView } from './retrieval.js';
import { SYSTEM, ORGANIZE, ORGANIZE_CONTRACT, FOLLOWUP, ANSWER, ANSWER_CONTRACT, PROMPT_VERSION } from './prompts.js';

const TYPES = new Set(['organize', 'followup', 'answer', 'minutes']);
const INSUFFICIENT = '本次会议转录中没有足够依据回答这个问题。';
const CLARIFICATION_QUERY = '当前选择 范围 下一步行动 概念含义 隐含前提 评价标准 分歧 取舍 待澄清';

class StaleResult extends Error { constructor() { super('会议内容已修正，本次结果未写入；请重新生成。'); this.code = 'STALE_RESULT'; } }
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const date = () => new Date().toISOString();

function parseJSON(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(text); } catch { throw fail('模型没有返回有效 JSON，请重试。', 502); }
  if (!result || Array.isArray(result) || typeof result !== 'object') throw fail('模型结果格式无效，请重试。', 502);
  return result;
}

function validateResult(result, purpose) {
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const objects = value => Array.isArray(value) && value.every(object);
  const citations = value => objects(value) && value.every(item => typeof item.id === 'string' && typeof item.quote === 'string');
  let valid;
  if (purpose === 'answer') {
    valid = typeof result.answer === 'string' && citations(result.evidence)
      && (result.inference === undefined || typeof result.inference === 'string')
      && (result.insufficient === undefined || typeof result.insufficient === 'boolean');
  } else {
    valid = objects(result.topics) && objects(result.followups)
      && result.followups.every(item => ['shortQuestion','discussionValue'].every(key => item[key] === undefined || typeof item[key] === 'string'))
      && result.topics.every(topic => topic.entries === undefined || objects(topic.entries))
      && ['merges', 'mergedFollowups', 'resolvedFollowups'].every(key => result[key] === undefined || objects(result[key]))
      && (result.resolvedFollowups === undefined || result.resolvedFollowups.every(item => object(item.resolution) && typeof item.resolution.complete === 'boolean'))
      && (result.focusFollowupId === undefined || result.focusFollowupId === null || typeof result.focusFollowupId === 'string')
      && (result.keepFollowupIds === undefined || Array.isArray(result.keepFollowupIds) && result.keepFollowupIds.every(id => typeof id === 'string'));
  }
  if (!valid) throw fail(`模型返回的${purpose === 'answer' ? '问答' : '会议整理'}结果格式无效，请重试。`, 502);
  return result;
}

function packSources(lines, maxChars = 12000) {
  const chunks = [];
  let chunk = [], size = 0;
  for (const line of lines) {
    for (let offset = 0; offset < line.text.length; offset += 6500) {
      const part = { ...line, text: line.text.slice(offset, offset + 6500) };
      const cost = part.text.length + 200;
      if (chunk.length && (size + cost > maxChars || chunk.some(item => item.id === part.id))) { chunks.push(chunk); chunk = []; size = 0; }
      chunk.push(part); size += cost;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function snapshotMatches(store, snapshot, lines) {
  const current = store.getMeeting(snapshot.id);
  if (current.contentRevision !== snapshot.contentRevision || (current.transcriptEditRevision || 0) !== (snapshot.transcriptEditRevision || 0) || current.archived) return false;
  const currentLines = new Map(sourceLines(snapshot.id, store.allTranscript(snapshot.id)).map(line => [line.id, line]));
  return lines.every(line => {
    const currentLine = currentLines.get(line.id);
    return currentLine && currentLine.revision === line.revision && currentLine.text === line.text && currentLine.speakerId === line.speakerId;
  });
}

function minutesMarkdown(meeting, lines) {
  const byId = new Map(lines.map(line => [line.id, line]));
  const evidenceLink = id => {
    const line = byId.get(id);
    if (!line) return '';
    const seconds = Math.floor((line.startMs || 0) / 1000);
    const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return `[${time}](#transcript:${encodeURIComponent(id)})`;
  };
  const content = [`# ${meeting.title}`, '', `已整理的转录版本：${meeting.processedRevision} · 生成时间：${date()}`, ''];
  if (meeting.processedRevision < meeting.transcriptRevision) content.push('仍有新增转录待整理，本文是当前已整理部分的纪要。', '');
  if (meeting.goal) content.push(`会议目标（不作为会议事实）：${meeting.goal}`, '');
  const entries = (meeting.topics || []).filter(t => !t.mergedInto).flatMap(topic => (topic.entries || []).map(entry => ({ ...entry, topicTitle: topic.title }))).filter(entry => !entry.stale && entry.status !== 'superseded');
  const clarifications = (meeting.followups || []).filter(item => item.status !== 'ignored' && !item.mergedInto && !item.stale && !item.resolution?.stale);
  const authorLabel = author => author === 'host' ? '主持人记录' : author === 'agent' ? 'Agent 记录' : 'AI 按原文整理';
  const sections = [
    ['决定', entry => entry.type === 'decision' && entry.status === 'active'],
    ['行动项', entry => entry.type === 'action' && entry.status !== 'resolved'],
    ['未决问题', entry => entry.type === 'question' && entry.status !== 'resolved'],
    ['讨论要点', entry => entry.type === 'viewpoint'],
  ];
  for (const [title, matches] of sections) {
    content.push(`## ${title}`, '');
    const selected = entries.filter(matches);
    if (!selected.length) content.push('暂无有原文依据的记录。', '');
    for (const entry of selected) {
      const metadata = [entry.owner ? `负责人：${entry.owner}` : '', entry.due ? `时间：${entry.due}` : ''].filter(Boolean).join('；');
      content.push(`- **${entry.topicTitle}**：${entry.text}${metadata ? `（${metadata}）` : ''} ${(entry.evidenceIds || []).map(evidenceLink).filter(Boolean).join(' ')}`);
      if (entry.type === 'decision') {
        const topicId = meeting.topics.find(topic => (topic.entries || []).some(item => item.id === entry.id))?.id;
        for (const item of clarifications.filter(item => item.kind === 'assumption' && item.topicId === topicId && item.status !== 'recorded' && item.resolution?.outcome !== 'recorded')) {
          const resolution = item.resolution;
          const label = resolution ? `${authorLabel(resolution.author)}；${resolution.outcome === 'needs_verification' ? '前提仍待验证' : resolution.outcome === 'difference_remains' ? '分歧仍在' : '已记录澄清'}` : 'AI 待核对解释';
          content.push(`  - 相关前提（${label}）：${resolution?.text || item.question}${item.impact ? `；影响：${item.impact}` : ''} ${(resolution?.evidenceIds || item.evidenceIds || []).map(evidenceLink).filter(Boolean).join(' ')}`);
        }
      }
    }
    if (selected.length) content.push('');
  }
  const clarificationSections = [
    ['讨论记录', item => item.status === 'recorded' && item.resolution?.outcome === 'recorded'],
    ['已澄清口径', item => item.status === 'resolved' && item.resolution?.outcome === 'clarified'],
    ['待验证前提', item => item.status === 'resolved' && item.resolution?.outcome === 'needs_verification'],
    ['仍有分歧或取舍', item => item.status === 'resolved' && item.resolution?.outcome === 'difference_remains'],
    ['尚待澄清', item => ['active','recorded'].includes(item.status)],
  ];
  for (const [title, matches] of clarificationSections) {
    content.push(`## ${title}`, '');
    const selected = clarifications.filter(matches);
    if (!selected.length) { content.push('暂无记录。', ''); continue; }
    for (const item of selected) {
      const resolution = item.resolution && (title !== '尚待澄清' || item.resolution.complete === false) ? item.resolution : null;
      const label = resolution ? `${authorLabel(resolution.author)}${resolution.complete === false ? '；已有部分进展，问题尚未解决' : ''}${resolution.outcome === 'recorded' ? '；未标记为已解决' : ''}` : `${item.author === 'ai' ? 'AI 待核对解释' : authorLabel(item.author)}${item.status === 'recorded' ? '；已有讨论记录，问题仍待澄清' : ''}`;
      const evidenceIds = resolution?.evidenceIds || item.evidenceIds || [];
      content.push(`- **${item.question}**（${label}${resolution ? `；依据版本 ${resolution.sourceRevision}${evidenceIds.length?'':'；未关联原文'}` : ''}）`, `  ${resolution?.text || item.rationale || ''}${item.impact && resolution?.outcome !== 'recorded' ? ` 可能影响：${item.impact}` : ''} ${evidenceIds.map(evidenceLink).filter(Boolean).join(' ')}`);
    }
    content.push('');
  }
  if ((meeting.followups || []).some(item => item.stale || item.resolution?.stale)) content.push('部分澄清记录的依据已变化，待核对后再纳入纪要。', '');
  return minutesDocumentMarkdown({ type: 'minutes', author: 'ai', markdown: content.join('\n') });
}

async function providerErrorKind(response) {
  // Inspect only a bounded error body. Its contents never become a displayed error.
  let text = '';
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let remaining = 16384;
    try {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value.subarray(0, remaining);
        text += decoder.decode(part, { stream: true });
        remaining -= part.length;
      }
    } catch { /* The HTTP status still provides a safe fallback. */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  let error;
  try { const payload = JSON.parse(text); error = payload?.error || payload; } catch { error = {}; }
  const field = name => typeof error?.[name] === 'string' ? error[name].toLowerCase() : '';
  const code = `${field('code')} ${field('type')}`, message = field('message');
  if ([401, 403].includes(response.status) || /invalid_api_key|authentication|unauthorized|access_denied/.test(code)) return 'auth';
  if (response.status === 402 || /insufficient_quota|quota_exceeded|billing_hard_limit|insufficient_balance|balance_not_enough|payment_required|credit_balance_too_low/.test(code)
    || /(?:insufficient|exceeded|exhausted|not enough)[^.!\n]{0,60}(?:quota|balance|credits)|(?:quota|balance|credits)[^.!\n]{0,60}(?:exceeded|exhausted|insufficient|too low)|余额不足|额度不足|配额已用尽/.test(message)) return 'quota';
  if (/invalid[._-]model|unsupported[._-]model|unknown[._-]model|model[._-](?:not[._-](?:found|exist)|invalid|unsupported)/.test(code)
    || field('param') === 'model'
    || /(?:invalid|unknown|unsupported|unrecognized) (?:api )?model|model(?: name| id)?[^.!\n]{0,120}(?:does not exist|not found|not supported|is invalid)|supported (?:api )?model names? (?:are|include)|模型(?:名称)?(?:无效|不存在|不支持)/.test(message)) return 'model';
  if (/unsupported[._-](?:response[._-]format|json[._-](?:mode|object))/.test(code)
    || (field('param') === 'response_format' || /response_format|json_object|json mode/.test(message)) && /unsupported|not supported|does not support|not available|not allowed|unrecognized|unknown|不支持/.test(`${code} ${message}`)) return 'format';
  return null;
}

const providerErrorMessages = {
  auth: '大模型鉴权失败，请在连接设置中检查 API Key 和访问权限。',
  quota: '大模型账户余额或可用额度不足，请检查供应商账户后重试。',
  model: '大模型名称无效或不可用，请在连接设置中核对模型名称。',
  format: '大模型不支持当前的输出格式，请检查模型和 API 的兼容性。',
};

/** Persistent jobs, one in flight per meeting; injectable request/timing seams support deterministic tests. */
export function createAIService({ store, fetchImpl = globalThis.fetch, intervalMs = 30000, requestTimeoutMs = 300000 }) {
  let started = false, timer = null;
  const running = new Map();
  const controllers = new Set();
  const lastAutomatic = new Map();

  async function complete(instructions, data, execution, purpose) {
    const llm = store.getSettings().llm || {};
    if (!llm.baseUrl || !llm.model) throw fail('请先配置大模型 API 地址和模型。');
    let base;
    try { base = new URL(llm.baseUrl); } catch { throw fail('大模型 API 地址无效。'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fail('大模型 API 地址无效。');
    if (!llm.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw fail('请先在设置中填写大模型 API Key。');
    const url = llm.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
    const call = { purpose, promptVersion: PROMPT_VERSION, model: llm.model, reasoningEffort: llm.reasoningEffort || 'default', sourceRevision: data.sourceRevision, startedAt: date() };
    execution.modelCalls.push(call);
    store.updateJob(execution.jobId, { promptVersion: PROMPT_VERSION, model: llm.model, reasoningEffort: call.reasoningEffort, sourceRevision: data.sourceRevision, modelCalls: execution.modelCalls });
    let jsonFormat = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!started) throw Object.assign(new Error('AI 服务已停止。'), { name: 'AbortError' });
      const controller = new AbortController(); controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(new Error('大模型请求超时，请重试。')), requestTimeoutMs); timeout.unref?.();
      let retry = false;
      try {
        const response = await fetchImpl(url, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}) },
          body: JSON.stringify({ model: llm.model, temperature: 0.2, stream: false, ...(llm.reasoningEffort ? { reasoning_effort: llm.reasoningEffort } : {}), ...(jsonFormat ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: `${SYSTEM}\n${instructions}${call.formatRetries ? `\n上次输出未通过格式校验，请仅返回符合以上输出契约的 JSON 对象：${purpose === 'answer' ? 'answer 必须是字符串，evidence 必须是引用数组。' : 'topics 和 followups 必须是数组，resolvedFollowups 中每项 resolution.complete 必须显式填写布尔值。'}` : ''}` }, { role: 'user', content: JSON.stringify(data) }] }),
        });
        if (!response.ok) {
          const kind = await providerErrorKind(response);
          if (jsonFormat && attempt < 2 && (kind === 'format' || !kind && response.status === 400)) { jsonFormat = false; retry = true; }
          else if (!kind && [408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 2) retry = true;
          else throw fail(`${providerErrorMessages[kind] || '大模型请求失败，请检查模型配置后重试。'}（HTTP ${response.status}）`, 502);
        } else {
          try {
            const payload = await response.json();
            return validateResult(parseJSON(payload?.choices?.[0]?.message?.content), purpose);
          } catch (error) {
            // A successful HTTP response can still contain broken JSON or an
            // incomplete contract. Retry that batch once, within the same total
            // request budget, without feeding the provider response back in.
            if (!(error instanceof SyntaxError) && error.status !== 502) throw error;
            if (!call.formatRetries && attempt < 2) {
              call.formatRetries = 1;
              store.updateJob(execution.jobId, { modelCalls: execution.modelCalls });
              retry = true;
            } else throw error.status ? error : fail('大模型响应不是有效 JSON，请重试。', 502);
          }
        }
      } catch (error) {
        if (!started) throw Object.assign(new Error('AI 服务已停止。'), { name: 'AbortError' });
        if (controller.signal.aborted) throw fail('大模型请求超时，请重试。', 504);
        if (error.status || attempt >= 2) throw error.status ? error : fail('无法连接大模型服务，请检查连接和配置。', 502);
        retry = true;
      } finally { clearTimeout(timeout); controllers.delete(controller); }
      if (retry) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
    throw fail('大模型服务暂时不可用，请重试。', 502);
  }

  async function organize(meetingId, { followupOnly = false, manual = false, force = false, execution } = {}) {
    const snapshot = store.getMeeting(meetingId);
    const allLines = sourceLines(meetingId, store.allTranscript(meetingId));
    if (!allLines.length) return { processedRevision: snapshot.processedRevision, skipped: 'no_transcript' };
    if (!force && !followupOnly && snapshot.processedRevision === snapshot.transcriptRevision && !(snapshot.topics || []).some(t => t.stale)) return { processedRevision: snapshot.processedRevision, skipped: 'no_new_transcript' };
    const changed = force || snapshot.processedRevision === 0 ? allLines : allLines.slice(snapshot.processedLineCount ?? Math.min(snapshot.processedRevision, allLines.length));
    const batches = followupOnly ? [retrieve(snapshot, allLines, CLARIFICATION_QUERY, null, 12000)] : packSources(changed.length ? changed : allLines);
    const reviewWholeMeeting = !followupOnly && batches.length > 1;
    store.updateJob(execution.jobId, { progress: { phase: 'organize', completedBatches: 0, totalBatches: batches.length } });
    let draft = structuredClone(snapshot);
    let additionsRemaining = manual ? 3 : 1;
    for (let index = 0; index < batches.length; index++) {
      const sources = supplementEvidence(draft, batches[index], allLines);
      // Multi-batch organization checks for new questions after all topics are available.
      const limit = reviewWholeMeeting ? 0 : additionsRemaining;
      const payload = await complete(`${ORGANIZE}\n${ORGANIZE_CONTRACT}${followupOnly ? `\n${FOLLOWUP}` : ''}`, {
        meetingId, goal: snapshot.goal, sourceRevision: snapshot.transcriptRevision,
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot.speakerLabels), followupLimit: limit,
        mode: followupOnly ? 'followup' : 'organize', meetingStatus: snapshot.status, reanalysis: force, batch: { index: index + 1, total: batches.length },
      }, execution, followupOnly ? 'followup' : 'organize');
      if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
      const before = draft.followups.length;
      // Prior summaries may cite real lines omitted from this bounded prompt.
      // Validate against this meeting's immutable snapshot, not the prompt window.
      draft = reduceOrganization(draft, payload, allLines, { sourceRevision: snapshot.transcriptRevision, followupLimit: limit, fresh: true, allowStructure: !followupOnly });
      additionsRemaining -= draft.followups.length - before;
      store.updateJob(execution.jobId, { progress: { phase: 'organize', completedBatches: index + 1, totalBatches: batches.length } });
    }
    if (reviewWholeMeeting) {
      store.updateJob(execution.jobId, { progress: { phase: 'clarify', completedBatches: batches.length, totalBatches: batches.length } });
      const sources = supplementEvidence(draft, retrieve(draft, allLines, CLARIFICATION_QUERY, null, 12000), allLines);
      const limit = Math.min(1, additionsRemaining);
      const payload = await complete(`${ORGANIZE}\n${ORGANIZE_CONTRACT}\n${FOLLOWUP}`, {
        meetingId, goal: snapshot.goal, sourceRevision: snapshot.transcriptRevision,
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot.speakerLabels), followupLimit: limit,
        mode: 'followup', meetingStatus: snapshot.status, reanalysis: force, batch: { index: 1, total: 1 },
      }, execution, 'followup');
      if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
      const before = draft.followups.length;
      draft = reduceOrganization(draft, payload, allLines, { sourceRevision: snapshot.transcriptRevision, followupLimit: limit, fresh: true, allowStructure: false });
      additionsRemaining -= draft.followups.length - before;
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    const current = store.getMeeting(meetingId);
    const fresh = current.transcriptRevision === snapshot.transcriptRevision;
    store.mutateMeeting(meetingId, meeting => {
      const changed = JSON.stringify(meeting.topics) !== JSON.stringify(draft.topics) || JSON.stringify(meeting.followups) !== JSON.stringify(draft.followups);
      if (changed) for (const artifact of meeting.artifacts || []) { artifact.stale = true; artifact.staleReason = 'content_changed'; }
      meeting.topics = draft.topics;
      if (Object.hasOwn(draft, 'focusFollowupId')) { meeting.focusFollowupId = draft.focusFollowupId; meeting.focusSourceRevision = draft.focusSourceRevision; }
      meeting.followups = draft.followups.map(item => !fresh && (item.status === 'active' || item.resolution?.author === 'ai' && item.resolution.sourceRevision === snapshot.transcriptRevision) ? { ...item, pendingReview: true, ...(item.resolution?.author === 'ai' ? { resolution: { ...item.resolution, pendingReview: true } } : {}) } : item);
      if (!followupOnly) {
        meeting.processedRevision = snapshot.transcriptRevision;
        meeting.processedLineCount = allLines.length;
        meeting.processedThroughMs = allLines.reduce((end, line) => Math.max(end, line.endMs || line.startMs || 0), 0);
      }
    });
    return { reanalyzed: force, processedRevision: snapshot.transcriptRevision, processedThroughMs: store.getMeeting(meetingId).processedThroughMs, addedFollowups: (manual ? 3 : 1) - additionsRemaining, pendingRevision: fresh ? null : current.transcriptRevision };
  }

  async function answer(meetingId, input, execution) {
    const snapshot = store.getMeeting(meetingId);
    const allLines = sourceLines(meetingId, store.allTranscript(meetingId));
    const sources = retrieve(snapshot, allLines, input.question, input.topicId);
    let result = { answer: INSUFFICIENT, inference: '', evidence: [] };
    if (sources.length) {
      const raw = await complete(`${ANSWER}\n${ANSWER_CONTRACT}`, {
        meetingId, question: input.question, topicId: input.topicId || null, sourceRevision: snapshot.transcriptRevision, ...knownContext(snapshot, sources), sources: sourceView(sources, snapshot.speakerLabels), totalTranscriptLines: allLines.length, retrievedLines: sources.length,
      }, execution, 'answer');
      const evidence = evidenceFor(raw, new Map(sources.map(line => [line.id, line])));
      if (evidence && raw.insufficient !== true && typeof raw.answer === 'string' && raw.answer.trim()) result = { answer: raw.answer.trim().slice(0, 12000), inference: typeof raw.inference === 'string' ? raw.inference.trim().slice(0, 6000) : '', evidence };
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    const item = { id: `answer_${randomUUID()}`, question: input.question, topicId: input.topicId || null, ...result, evidenceIds: [...new Set(result.evidence.map(item => item.id))], sourceRevision: snapshot.transcriptRevision, sourceThroughMs: allLines.reduce((end,line)=>Math.max(end,line.endMs || line.startMs || 0),0), stale: false, author: 'ai', createdAt: date() };
    store.mutateMeeting(meetingId, meeting => { meeting.questions ||= []; meeting.questions.push(item); });
    return item;
  }

  async function reviewOpenQuestions(meetingId, execution) {
    const snapshot = store.getMeeting(meetingId);
    const pending = (snapshot.followups || []).filter(item => !item.mergedInto && (item.status === 'active' || item.stale || item.pendingReview) && item.status !== 'ignored' && item.status !== 'recorded' && (!item.resolution || item.resolution.author === 'ai') && !(item.manualFields || []).some(field => ['resolution', 'status'].includes(field)));
    if (!pending.length) return;
    const allLines = sourceLines(meetingId, store.allTranscript(meetingId));
    let draft = structuredClone(snapshot);
    for (let offset = 0; offset < pending.length; offset += 6) {
      const group = pending.slice(offset, offset + 6);
      const sources = reviewEvidence(draft, allLines, group);
      store.updateJob(execution.jobId, { progress: { phase: 'clarify', completedBatches: offset / 6, totalBatches: Math.ceil(pending.length / 6) } });
      const payload = await complete(`${ORGANIZE}\n${ORGANIZE_CONTRACT}\n${FOLLOWUP}\n本次核对 reviewFollowupIds 中的问题是否已被后续发言回答、已有部分进展，或实际上属于同一个问题。sources 含按问题检索的上下文；没有找到答案不等于会上没有答案。未充分核对的问题保持待核对。此轮不新增问题。`, {
        meetingId, goal: snapshot.goal, sourceRevision: snapshot.transcriptRevision,
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot.speakerLabels),
        mode: 'review', meetingStatus: snapshot.status, reviewFollowupIds: group.map(item => item.id), followupLimit: 0,
      }, execution, 'followup');
      if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
      draft = reduceOrganization(draft, payload, allLines, { sourceRevision: snapshot.transcriptRevision, followupLimit: 0, allowStructure: false });
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    const fresh = store.getMeeting(meetingId).transcriptRevision === snapshot.transcriptRevision;
    store.mutateMeeting(meetingId, meeting => {
      if (JSON.stringify(meeting.followups) !== JSON.stringify(draft.followups)) for (const artifact of meeting.artifacts || []) { artifact.stale = true; artifact.staleReason = 'content_changed'; }
      meeting.followups = draft.followups.map(item => !fresh && (item.status === 'active' || item.resolution?.author === 'ai' && item.resolution.sourceRevision === snapshot.transcriptRevision) ? { ...item, pendingReview: true, ...(item.resolution?.author === 'ai' ? { resolution: { ...item.resolution, pendingReview: true } } : {}) } : item);
      if (Object.hasOwn(draft, 'focusFollowupId')) { meeting.focusFollowupId = draft.focusFollowupId; meeting.focusSourceRevision = draft.focusSourceRevision; }
    });
  }

  async function minutes(meetingId, execution) {
    await organize(meetingId, { execution });
    await reviewOpenQuestions(meetingId, execution);
    store.updateJob(execution.jobId, { progress: { ...store.getJob(execution.jobId).progress, phase: 'minutes' } });
    const snapshot = store.getMeeting(meetingId);
    const lines = sourceLines(meetingId, store.allTranscript(meetingId));
    const existing = (snapshot.artifacts || []).find(artifact => artifact.type === 'minutes');
    // Preserve a human/agent edited minutes document. A refreshed draft is a separate reusable artifact.
    const edited = existing && existing.author !== 'ai';
    let type = edited ? 'minutes-draft' : 'minutes';
    // Agents can edit any artifact through MCP, including an update draft.
    // Reuse only an AI-owned slot; never overwrite an authored draft.
    if (edited) {
      let version = 2;
      while ((snapshot.artifacts || []).some(artifact => artifact.type === type && artifact.author !== 'ai')) type = `minutes-draft-${version++}`;
    }
    const artifact = store.saveArtifact(meetingId, type, { title: edited ? '会议纪要更新草稿' : '会议纪要', markdown: minutesMarkdown(snapshot, lines), author: 'ai', sourceRevision: snapshot.processedRevision });
    return artifact;
  }

  async function run(job) {
    const execution = { jobId: job.id, modelCalls: [] };
    store.updateJob(job.id, { status: 'running', error: null, progress: null, promptVersion: PROMPT_VERSION, model: null, reasoningEffort: null, modelCalls: [], sourceRevision: store.getMeeting(job.meetingId).transcriptRevision });
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (job.type === 'answer') result = await answer(job.meetingId, job.input, execution);
          else if (job.type === 'minutes') result = await minutes(job.meetingId, execution);
          else {
            result = await organize(job.meetingId, { followupOnly: job.type === 'followup', manual: job.type === 'followup', force: job.input?.force === true, execution });
            if (job.type === 'organize' && job.input?.force) await reviewOpenQuestions(job.meetingId, execution);
          }
          break;
        } catch (error) { if (error.code !== 'STALE_RESULT' || attempt === 2) throw error; }
      }
      if (started) store.updateJob(job.id, { status: 'done', result, error: null, progress: { ...store.getJob(job.id).progress, phase: 'done' } });
      else store.updateJob(job.id, { status: 'queued', error: null });
    } catch (error) {
      store.updateJob(job.id, { status: !started ? 'queued' : error.code === 'STALE_RESULT' ? 'cancelled' : 'error', error: !started ? null : error.message, result: null });
    }
  }

  function pump() {
    if (!started) return;
    const jobs = store.pendingJobs().filter(job => TYPES.has(job.type) && job.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) {
      if (running.has(job.meetingId)) continue;
      const promise = run(job).finally(() => { running.delete(job.meetingId); if (started) queueMicrotask(pump); });
      running.set(job.meetingId, promise);
    }
  }

  function submit(meetingId, type, input = {}) {
    const meeting = store.getMeeting(meetingId);
    if (!TYPES.has(type)) throw fail('不支持的 AI 任务类型。');
    if (meeting.archived) throw fail('请先恢复归档会议。');
    if (input.topicId && !(meeting.topics || []).some(topic => topic.id === input.topicId && !topic.mergedInto)) throw fail('主题不属于本次会议。');
    const normalized = {};
    if (type === 'answer') {
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4000) throw fail('请输入 1–4000 字的问题。');
      normalized.question = input.question.trim(); if (input.topicId) normalized.topicId = input.topicId;
    }
    if (type === 'organize') {
      if (input.force !== undefined && typeof input.force !== 'boolean') throw fail('force 必须为布尔值。');
      if (input.force) normalized.force = true;
      const existing = store.pendingJobs().find(job => job.meetingId === meetingId && ['organize', 'minutes'].includes(job.type) && (!normalized.force || job.type === 'organize' && job.input?.force === true));
      if (existing) return existing;
    }
    const job = store.createJob(meetingId, type, normalized);
    if (started) queueMicrotask(pump);
    return job;
  }

  function schedule() {
    if (!started) return;
    for (const meeting of store.listMeetings()) {
      if (!meeting.autoOrganize || meeting.archived || meeting.status === 'ended' || meeting.capture?.state !== 'recording' || meeting.transcriptRevision === meeting.processedRevision || !meeting.transcriptRevision) continue;
      if (Date.now() - (lastAutomatic.get(meeting.id) || 0) < intervalMs) continue;
      if (store.pendingJobs().some(job => job.meetingId === meeting.id && ['organize', 'minutes'].includes(job.type))) continue;
      const llm = store.getSettings().llm;
      if (!llm?.baseUrl || !llm?.model || (!llm.apiKey && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(llm.baseUrl))) continue;
      lastAutomatic.set(meeting.id, Date.now());
      submit(meeting.id, 'organize');
    }
  }

  function start() {
    if (started) return;
    started = true;
    for (const job of store.pendingJobs()) if (TYPES.has(job.type) && job.status === 'running') store.updateJob(job.id, { status: 'queued', error: null });
    timer = setInterval(schedule, intervalMs); timer.unref?.();
    queueMicrotask(pump);
  }

  async function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...running.values()]);
  }

  return { submit, start, stop };
}
