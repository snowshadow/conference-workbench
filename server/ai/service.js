import { randomUUID } from 'node:crypto';
import { runRetrospective } from './retrospective.js';
import { minutesDocumentMarkdown } from '../../shared/minutes-format.js';
import { resolutionOutcomes } from '../../shared/resolution-copy.js';
import { reduceOrganization } from './reducer.js';
import { attributedPeople, groundedPeopleText, markPeopleFields, peopleRecordTarget, peopleReviewRecords, validPeopleReferences } from './people.js';
import { peopleReviewErrors } from './people-errors.js';
import { knownContext, supplementEvidence, reviewEvidence } from './context.js';
import { answerBatches, answerCandidates, answerScope, evidenceFor, retrieve, sourceLines, sourceView } from './retrieval.js';
import { SYSTEM, ORGANIZE, ORGANIZE_CONTRACT, FOLLOWUP, ANSWER, ANSWER_CONTRACT, ANSWER_SELECT, REFRESH_PEOPLE, PROMPT_VERSION } from './prompts.js';

const TYPES = new Set(['organize', 'followup', 'answer', 'minutes', 'refresh_speakers']);
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
  if (purpose === 'refresh_speakers') {
    valid = objects(result.records) && result.records.every(item => typeof item.id === 'string' && typeof item.text === 'string' && citations(item.evidence) && (item.participantIds === undefined || Array.isArray(item.participantIds) && item.participantIds.every(id => typeof id === 'string')));
  } else if (purpose === 'answer_select') {
    valid = Array.isArray(result.sourceIds) && result.sourceIds.length <= 24 && result.sourceIds.every(id => typeof id === 'string');
  } else if (purpose === 'answer') {
    valid = typeof result.answer === 'string' && citations(result.evidence)
      && (result.inference === undefined || typeof result.inference === 'string')
      && (result.insufficient === undefined || typeof result.insufficient === 'boolean');
  } else {
    if (purpose === 'retrospective_focus' && result.topics === undefined) result.topics = [];
    valid = objects(result.topics) && objects(result.followups)
      && result.followups.every(item => ['shortQuestion','discussionValue'].every(key => item[key] === undefined || typeof item[key] === 'string'))
      && result.followups.every(item => item.priority === undefined || object(item.priority)
        && ['high', 'medium', 'low'].includes(item.priority.level) && typeof item.priority.reason === 'string' && item.priority.reason.trim().length > 0 && item.priority.reason.trim().length <= 600)
      && result.followups.every(item => item.clarification === undefined || object(item.clarification)
        && typeof item.clarification.explanation === 'string' && citations(item.clarification.evidence)
        && (item.clarification.distinctions === undefined || objects(item.clarification.distinctions)
          && item.clarification.distinctions.every(part => typeof part.title === 'string' && typeof part.text === 'string'
            && (part.example === undefined || typeof part.example === 'string') && citations(part.evidence))))
      && result.topics.every(topic => topic.entries === undefined || objects(topic.entries))
      && ['merges', 'mergedFollowups', 'resolvedFollowups'].every(key => result[key] === undefined || objects(result[key]))
      && (result.resolvedFollowups === undefined || result.resolvedFollowups.every(item => object(item.resolution) && typeof item.resolution.complete === 'boolean'))
      && (result.retiredFollowups === undefined || objects(result.retiredFollowups)
        && result.retiredFollowups.every(item => typeof item.id === 'string' && typeof item.reason === 'string' && citations(item.evidence)))
      && (result.focusFollowupId === undefined || result.focusFollowupId === null || typeof result.focusFollowupId === 'string')
      && (result.keepFollowupIds === undefined || Array.isArray(result.keepFollowupIds) && result.keepFollowupIds.every(id => typeof id === 'string'));
  }
  if (purpose.startsWith('retrospective_') && valid) {
    const supported = evidence => citations(evidence) && evidence.length > 0 && evidence.length <= 30;
    valid = result.followups.every(item => item.retrospective === true && ['concept', 'assumption', 'criteria', 'other'].includes(item.kind)
      && ['question', 'rationale', 'impact'].every(key => typeof item[key] === 'string' && item[key].trim())
      && object(item.clarification) && item.clarification.explanation.trim() && supported(item.evidence) && supported(item.clarification.evidence)
      && (item.clarification.distinctions || []).every(part => part.title.trim() && part.text.trim() && supported(part.evidence))
      && (item.resolution === undefined || object(item.resolution) && ['clarified', 'needs_verification', 'difference_remains'].includes(item.resolution.outcome) && typeof item.resolution.complete === 'boolean' && typeof item.resolution.text === 'string' && item.resolution.text.trim() && supported(item.resolution.evidence)));
  }
  if (!valid) throw fail(`模型返回的${purpose === 'answer_select' ? '问答来源选择' : purpose === 'answer' ? '问答' : purpose === 'refresh_speakers' ? '发言人核对' : '会议整理'}结果格式无效，请重试。`, 502);
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
    return currentLine && currentLine.revision === line.revision && currentLine.text === line.text && currentLine.speakerId === line.speakerId && currentLine.participantId === line.participantId;
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
  const clarifications = (meeting.followups || []).filter(item => item.status !== 'ignored' && !item.mergedInto && !item.stale && !item.resolution?.stale)
    .filter(item => meeting.source !== 'recording_import' || !meeting.retrospectiveAnalysis?.focusCompleted || item.retrospective || item.author !== 'ai' || item.manualFields?.length || item.resolution?.author && item.resolution.author !== 'ai');
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
  if (meeting.source === 'recording_import') {
    content.push('## 复盘焦点', '');
    const selected = clarifications.filter(item => item.attention?.needed !== false);
    if (!selected.length) content.push('暂无值得单独展开的复盘焦点。', '');
    for (const item of selected) {
      content.push(`### ${item.shortQuestion || item.question}`, '');
      if (item.impact) content.push(`回看价值：${item.impact}`, '');
      if (item.clarification && !item.clarification.stale) {
        content.push(`AI 理解建议（不是会议结论）：${item.clarification.explanation}`, '');
        for (const part of item.clarification.distinctions || []) {
          if (part.stale) continue;
          content.push(`- **${part.title}**：${part.text}${part.example ? ` 例如：${part.example}` : ''} ${(part.evidenceIds || []).map(evidenceLink).filter(Boolean).join(' ')}`);
        }
        content.push('');
      }
      if (item.resolution) content.push(`会末记录（${authorLabel(item.resolution.author)}；${item.resolution.complete ? '核心问题已说清' : item.resolution.outcome === 'recorded' ? '未确认是否解决' : '仍有关键问题未定'}）：${item.resolution.text}`, '');
      else content.push('会末没有记录到可确认的结果。', '');
      const ids = [...new Set([...(item.evidenceIds || []), ...(item.clarification?.evidenceIds || []), ...(item.resolution?.evidenceIds || [])])];
      content.push(`核对原话：${ids.map(evidenceLink).filter(Boolean).join(' ') || '未关联原文'}`, '');
    }
    return minutesDocumentMarkdown({ type: 'minutes', author: 'ai', markdown: content.join('\n') });
  }
  const clarificationSections = [
    ['讨论记录', item => item.status === 'recorded' && item.resolution?.outcome === 'recorded'],
    [resolutionOutcomes.clarified.label, item => item.status === 'resolved' && item.resolution?.outcome === 'clarified'],
    [resolutionOutcomes.needs_verification.label, item => item.status === 'resolved' && item.resolution?.outcome === 'needs_verification'],
    [resolutionOutcomes.difference_remains.label, item => item.status === 'resolved' && item.resolution?.outcome === 'difference_remains'],
    ['尚待澄清', item => ['active','recorded'].includes(item.status) && item.attention?.needed !== false],
    ['暂不展开的问题', item => item.status === 'active' && item.attention?.needed === false],
  ];
  for (const [title, matches] of clarificationSections) {
    const selected = clarifications.filter(matches);
    if (title === '暂不展开的问题' && !selected.length) continue;
    content.push(`## ${title}`, '');
    if (!selected.length) { content.push('暂无记录。', ''); continue; }
    for (const item of selected) {
      const resolution = item.resolution && (title !== '尚待澄清' || item.resolution.complete === false) ? item.resolution : null;
      const label = resolution ? `${authorLabel(resolution.author)}${resolution.complete === false ? '；已有部分进展，问题尚未解决' : ''}${resolution.outcome === 'recorded' ? '；未标记为已解决' : ''}` : `${item.author === 'ai' ? 'AI 待核对解释' : authorLabel(item.author)}${item.status === 'recorded' ? '；已有讨论记录，问题仍待澄清' : ''}`;
      const evidenceIds = resolution?.evidenceIds || item.evidenceIds || [];
      content.push(`- **${item.question}**（${label}${resolution ? `；依据版本 ${resolution.sourceRevision}${evidenceIds.length?'':'；未关联原文'}` : ''}）`, `  ${resolution?.text || item.rationale || ''}${item.impact && resolution?.outcome !== 'recorded' ? ` 可能影响：${item.impact}` : ''} ${evidenceIds.map(evidenceLink).filter(Boolean).join(' ')}`);
      if (title === '暂不展开的问题') content.push(`  暂不展开：${item.attention.reason} ${(item.attention.evidenceIds || []).map(evidenceLink).filter(Boolean).join(' ')}`);
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

const followupContent = items => JSON.stringify(items.map(({ priority, ...item }) => item));

/** Persistent jobs, one in flight per meeting; injectable request/timing seams support deterministic tests. */
export function createAIService({ store, fetchImpl = globalThis.fetch, intervalMs = 30000, requestTimeoutMs = 300000, retrospectiveMaxChars = 48000 }) {
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
    const callStarted = Date.now();
    const call = { purpose, promptVersion: execution.promptVersion || PROMPT_VERSION, model: llm.model, reasoningEffort: llm.reasoningEffort || 'default', sourceRevision: data.sourceRevision, startedAt: date() };
    execution.modelCalls.push(call);
    store.updateJob(execution.jobId, { promptVersion: execution.promptVersion || PROMPT_VERSION, model: llm.model, reasoningEffort: call.reasoningEffort, sourceRevision: data.sourceRevision, modelCalls: execution.modelCalls });
    try {
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
            body: JSON.stringify({ model: llm.model, temperature: 0.2, stream: false, ...(llm.reasoningEffort ? { reasoning_effort: llm.reasoningEffort } : {}), ...(jsonFormat ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: `${execution.system || SYSTEM}\n${instructions}${call.formatRetries ? `\n上次输出未通过格式校验，请仅返回符合以上输出契约的 JSON 对象：${purpose === 'answer_select' ? 'sourceIds 必须是本批原发言 ID 的数组，最多 24 条。' : purpose === 'answer' ? 'answer 必须是字符串，evidence 必须是引用数组。' : purpose === 'refresh_speakers' ? 'records 必须是数组，每项包含输入的 id、完整 text 和原文 evidence。' : purpose.startsWith('retrospective_') ? 'followups 中的焦点须含 retrospective=true、clarification 和 evidence；可省略 resolution，填写时包含 outcome、complete 布尔值、text 和 evidence。evidence 和 summaryEvidence 只需填写已有原话的 id，由系统取回原句，无需抄写 quote。若保留 quote 则必须逐字准确，保留原文的 ASR 错字、标点和用词；未知引用 ID 不可使用。' : 'topics 和 followups 必须是数组，resolvedFollowups 中每项 resolution.complete 必须显式填写布尔值。'}` : ''}` }, { role: 'user', content: JSON.stringify(data) }] }),
          });
          if (!response.ok) {
            const kind = await providerErrorKind(response);
            if (jsonFormat && attempt < 2 && (kind === 'format' || !kind && response.status === 400)) { jsonFormat = false; retry = true; }
            else if (!kind && [408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 2) retry = true;
            else throw fail(`${providerErrorMessages[kind] || '大模型请求失败，请检查模型配置后重试。'}（HTTP ${response.status}）`, 502);
          } else {
            try {
              const payload = await response.json();
              const parsed = parseJSON(payload?.choices?.[0]?.message?.content);
              const result = purpose.startsWith('retrospective_') && execution.validateResult
                ? validateResult(execution.validateResult(parsed), purpose)
                : validateResult(parsed, purpose);
              call.status = 'done';
              return result;
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
    } finally {
      call.endedAt = date(); call.durationMs = Date.now() - callStarted; call.status ||= 'error';
      store.updateJob(execution.jobId, { modelCalls: execution.modelCalls });
    }
  }

  async function organize(meetingId, { followupOnly = false, manual = false, force = false, execution } = {}) {
    const snapshot = store.getMeeting(meetingId);
    if (snapshot.source === 'recording_import') return runRetrospective({ store, meetingId, execution, complete, force, focusOnly: followupOnly, maxChars: retrospectiveMaxChars });
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
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot), followupLimit: limit,
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
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot), followupLimit: limit,
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
      const changed = JSON.stringify(meeting.topics) !== JSON.stringify(draft.topics) || followupContent(meeting.followups) !== followupContent(draft.followups);
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
    const scoped = answerScope(snapshot, allLines, input.topicId);
    const batches = answerBatches(scoped.sources, undefined, snapshot);
    const coverage = {
      strategy: batches.length > 1 ? 'semantic_batches' : 'full_scope',
      scope: input.topicId ? 'topic' : 'meeting', topicId: input.topicId || null,
      sourceRevision: snapshot.transcriptRevision, transcriptEditRevision: snapshot.transcriptEditRevision || 0,
      totalTranscriptLines: allLines.length, scopedLines: scoped.sources.length, reviewedLines: 0,
      selectedLines: 0, omittedCandidateLines: 0, complete: false,
      batches: batches.map(lines => ({ sources: lines.map(({ id, revision }) => ({ id, revision })), selectedSourceIds: [] })),
    };
    const publishCoverage = () => store.updateJob(execution.jobId, { coverage });
    publishCoverage();
    let sources = scoped.sources;
    if (batches.length > 1) {
      const selections = new Array(batches.length);
      let nextBatch = 0, completed = 0, failure;
      store.updateJob(execution.jobId, { progress: { phase: 'select', completedBatches: 0, totalBatches: batches.length } });
      const worker = async () => {
        while (!failure && nextBatch < batches.length) {
          const index = nextBatch++, batch = batches[index];
          try {
            const data = { meetingId, question: input.question, topicId: input.topicId || null, sourceRevision: snapshot.transcriptRevision, sources: sourceView(batch, snapshot), batch: { index: index + 1, total: batches.length } };
            let raw = await complete(ANSWER_SELECT, data, execution, 'answer_select');
            const ids = new Set(batch.map(line => line.id));
            if (raw.sourceIds.some(id => !ids.has(id))) raw = await complete(`${ANSWER_SELECT}\n上次选择包含本批不存在的发言 ID。请重新核对 sources，只选择本批真实 ID。`, data, execution, 'answer_select');
            if (raw.sourceIds.some(id => !ids.has(id))) throw fail('未能核对回答所需的原文来源，请重试。', 502);
            if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
            selections[index] = [...new Set(raw.sourceIds)];
            coverage.batches[index].selectedSourceIds = selections[index];
            coverage.reviewedLines += batch.length;
            publishCoverage();
            store.updateJob(execution.jobId, { progress: { phase: 'select', completedBatches: ++completed, totalBatches: batches.length } });
          } catch (error) { failure ||= error; }
        }
      };
      // Wait for both workers even on failure: no old request can update a job
      // after it has failed or the next per-meeting task has begun.
      await Promise.all([worker(), worker()]);
      if (failure) throw failure;
      sources = answerCandidates(batches, selections, undefined, snapshot);
      coverage.omittedCandidateLines = new Set(selections.flat()).size - sources.length;
    } else {
      if (batches.length) coverage.batches[0].selectedSourceIds = sources.map(line => line.id);
    }
    coverage.selectedSourceIds = sources.map(line => line.id);
    coverage.selectedLines = sources.length;
    coverage.complete = coverage.reviewedLines === coverage.scopedLines;
    publishCoverage();
    store.updateJob(execution.jobId, { progress: { phase: 'answer', completedBatches: batches.length, totalBatches: batches.length } });
    let result = { answer: scoped.sources.length ? '已查看这次会议的相关范围，但没有找到能回答这个问题的原话。' : input.topicId ? '这个主题还没有关联的原文，暂时无法据此回答。' : '这次会议还没有可用的转录，暂时无法回答。', inference: '', evidence: [], insufficient: true, reason: scoped.sources.length ? 'no_relevant_sources' : input.topicId ? 'no_topic_sources' : 'no_transcript' };
    if (sources.length) {
      const data = {
        meetingId, question: input.question, topicId: input.topicId || null, sourceRevision: snapshot.transcriptRevision,
        ...knownContext(scoped.meeting, sources), sources: sourceView(sources, snapshot),
        totalTranscriptLines: allLines.length, retrievedLines: sources.length,
        coverage: { strategy: coverage.strategy, scope: coverage.scope, scopedLines: coverage.scopedLines, reviewedLines: batches.length === 1 ? scoped.sources.length : coverage.reviewedLines, selectedLines: coverage.selectedLines, omittedCandidateLines: coverage.omittedCandidateLines },
      };
      const byId = new Map(sources.map(line => [line.id, line]));
      let accepted = false, failureReason;
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await complete(`${ANSWER}\n${ANSWER_CONTRACT}${attempt ? '\n上次回答未通过原文引用核对。请重新给出回答：引用必须使用 sources 中的 ID 和逐字原话；若原文确实不足，具体说明缺少什么并设置 insufficient=true。' : ''}`, data, execution, 'answer');
        if (batches.length === 1) { coverage.reviewedLines = scoped.sources.length; coverage.complete = true; publishCoverage(); }
        const evidence = raw.evidence.length ? evidenceFor(raw, byId) : [];
        failureReason = !raw.answer.trim() ? 'empty_answer' : !evidence || !evidence.length && (raw.insufficient !== true || raw.inference?.trim()) ? 'invalid_citations' : null;
        execution.modelCalls.at(-1).validation = failureReason || (raw.insufficient === true ? 'insufficient_evidence' : 'grounded');
        store.updateJob(execution.jobId, { modelCalls: execution.modelCalls });
        if (raw.answer.trim() && evidence && (evidence.length || raw.insufficient === true && !raw.inference?.trim())) {
          result = { answer: groundedPeopleText(raw.answer.trim().slice(0, 12000), evidence, byId, snapshot), inference: groundedPeopleText(raw.inference?.trim().slice(0, 6000) || '', evidence, byId, snapshot), evidence, insufficient: raw.insufficient === true, reason: raw.insufficient === true ? 'insufficient_evidence' : null };
          accepted = true; break;
        }
      }
      if (!accepted) throw fail(failureReason === 'empty_answer' ? 'AI 没有生成回答，请重试。' : '回答的原文引用未能核对，未保存这次回答。请重试。', 502);
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    const item = { id: `answer_${randomUUID()}`, question: input.question, topicId: input.topicId || null, ...result, coverage, evidenceIds: [...new Set(result.evidence.map(item => item.id))], sourceRevision: snapshot.transcriptRevision, sourceThroughMs: allLines.reduce((end,line)=>Math.max(end,line.endMs || line.startMs || 0),0), stale: false, author: 'ai', createdAt: date() };
    store.mutateMeeting(meetingId, meeting => { meeting.questions ||= []; markPeopleFields(item, ['answer', 'inference'], meeting); meeting.questions.push(item); });
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
      const payload = await complete(`${ORGANIZE}\n${ORGANIZE_CONTRACT}\n${FOLLOWUP}\n本次核对 reviewFollowupIds：哪些核心疑问已经回答，哪些还有值得澄清的差别，哪些虽有未知细节却已不阻碍讨论。分别使用 resolvedFollowups、更新 clarification 或 retiredFollowups，已有部分进展如实保留。sources 含按问题检索的上下文；没有找到答案不等于会上没有答案。未充分核对的问题保持待核对。此轮不新增问题。`, {
        meetingId, goal: snapshot.goal, sourceRevision: snapshot.transcriptRevision,
        ...knownContext(draft, sources), sources: sourceView(sources, snapshot),
        mode: 'review', meetingStatus: snapshot.status, reviewFollowupIds: group.map(item => item.id), followupLimit: 0,
      }, execution, 'followup');
      if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
      draft = reduceOrganization(draft, payload, allLines, { sourceRevision: snapshot.transcriptRevision, followupLimit: 0, allowStructure: false });
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    const fresh = store.getMeeting(meetingId).transcriptRevision === snapshot.transcriptRevision;
    store.mutateMeeting(meetingId, meeting => {
      if (followupContent(meeting.followups) !== followupContent(draft.followups)) for (const artifact of meeting.artifacts || []) { artifact.stale = true; artifact.staleReason = 'content_changed'; }
      meeting.followups = draft.followups.map(item => !fresh && (item.status === 'active' || item.resolution?.author === 'ai' && item.resolution.sourceRevision === snapshot.transcriptRevision) ? { ...item, pendingReview: true, ...(item.resolution?.author === 'ai' ? { resolution: { ...item.resolution, pendingReview: true } } : {}) } : item);
      if (Object.hasOwn(draft, 'focusFollowupId')) { meeting.focusFollowupId = draft.focusFollowupId; meeting.focusSourceRevision = draft.focusSourceRevision; }
    });
  }

  async function minutes(meetingId, execution) {
    await organize(meetingId, { execution });
    if (store.getMeeting(meetingId).source !== 'recording_import') await reviewOpenQuestions(meetingId, execution);
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
    const legacy = peopleReviewRecords(snapshot, lines, lines.map(line => line.id), 'labels').some(record => ['topics', 'followups'].includes(record.path[0]));
    if (!legacy) {
      markPeopleFields(artifact, ['markdown'], snapshot);
      store.mutateMeeting(meetingId, meeting => { const saved = meeting.artifacts.find(item => item.id === artifact.id); if (saved) saved.peopleFields = artifact.peopleFields; });
    }
    return artifact;
  }

  async function refreshPeople(meetingId, input, execution) {
    const snapshot = store.getMeeting(meetingId);
    const allLines = sourceLines(meetingId, store.allTranscript(meetingId));
    const byId = new Map(allLines.map(line => [line.id, line]));
    const records = peopleReviewRecords(snapshot, allLines, input.sourceIds, input.kind);
    if (!records.length) return { updatedFields: 0, skipped: 'no_identity_review_needed' };
    // Share source lines within a batch; never cut a record or its cited speech.
    const batches = [];
    let group = [], ids = new Set(), chars = 0;
    for (const record of records) {
      const extra = record.evidenceIds.filter(id => !ids.has(id));
      const cost = JSON.stringify(record).length + extra.reduce((sum, id) => sum + JSON.stringify(byId.get(id)).length, 0);
      if (group.length && chars + cost > 36000) { batches.push(group); group = []; ids = new Set(); chars = 0; }
      group.push(record);
      for (const id of record.evidenceIds) if (!ids.has(id)) { ids.add(id); chars += JSON.stringify(byId.get(id)).length; }
      chars += JSON.stringify(record).length;
    }
    if (group.length) batches.push(group);
    const updates = [];
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];
      const sourceIds = new Set(batch.flatMap(record => record.evidenceIds));
      store.updateJob(execution.jobId, { progress: { phase: 'refresh_speakers', completedBatches: index, totalBatches: batches.length } });
      const result = await complete(REFRESH_PEOPLE, {
        meetingId, sourceRevision: snapshot.transcriptRevision, mode: 'refresh_speakers', kind: input.kind,
        records: batch.map(({ path, field, ...record }) => record),
        sources: sourceView(allLines.filter(line => sourceIds.has(line.id)), snapshot),
      }, execution, 'refresh_speakers');
      if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
      const returned = new Map(result.records.map(item => [item.id, item]));
      if (returned.size !== batch.length || result.records.length !== batch.length) throw fail(peopleReviewErrors.incomplete, 502);
      for (const record of batch) {
        const result = returned.get(record.id);
        if (!result?.text.trim()) throw fail(peopleReviewErrors.incomplete, 502);
        const permitted = new Map(record.evidenceIds.map(id => [id, byId.get(id)]));
        const evidence = evidenceFor(result, permitted);
        if (!evidence) throw fail(peopleReviewErrors.evidence, 502);
        if (!validPeopleReferences(result.text, evidence, permitted, snapshot)) throw fail(peopleReviewErrors.attribution, 502);
        if (record.field === 'markdown') {
          const links = text => [...text.matchAll(/#transcript:([^\s)]+)/g)].map(match => match[1]).sort();
          if (JSON.stringify(links(record.text)) !== JSON.stringify(links(result.text))) throw fail(peopleReviewErrors.links, 502);
        }
        updates.push({ record, text: groundedPeopleText(result.text.trim(), evidence, permitted, snapshot), participantIds: attributedPeople(result, evidence, permitted, snapshot) });
      }
    }
    if (!snapshotMatches(store, snapshot, allLines)) throw new StaleResult();
    store.mutateMeeting(meetingId, meeting => {
      for (const { record, text, participantIds } of updates) {
        const target = peopleRecordTarget(meeting, record.path);
        // The snapshot guard protects edits made while the provider was running.
        if (!target || target.author && target.author !== 'ai' || target.manualFields?.includes(record.field)) continue;
        if (target[record.field] !== text) {
          target.history ||= [];
          target.history.push({ [record.field]: target[record.field], evidenceIds: record.evidenceIds, changedAt: date(), identityCorrected: true });
          target[record.field] = text;
        }
        markPeopleFields(target, [record.field], meeting);
        if (record.path.includes('entries') && record.field === 'text') target.participantIds = participantIds;
        target.identityReview = false;
        target.identityReviewedAt = date();
        if (target.staleReason === 'identity_changed') { target.stale = false; delete target.staleReason; }
      }
    });
    return { updatedFields: updates.length, sourceIds: input.sourceIds };
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
          else if (job.type === 'refresh_speakers') result = await refreshPeople(job.meetingId, job.input, execution);
          else {
            result = await organize(job.meetingId, { followupOnly: job.type === 'followup', manual: job.type === 'followup', force: job.input?.force === true, execution });
            if (job.type === 'organize' && job.input?.force && store.getMeeting(job.meetingId).source !== 'recording_import') await reviewOpenQuestions(job.meetingId, execution);
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
    if (type === 'refresh_speakers') {
      if (!Array.isArray(input.sourceIds) || input.sourceIds.some(id => typeof id !== 'string')) throw fail('请提供需要核对的原文。');
      const allowed = new Set(store.allTranscript(meetingId).map(line => line.id));
      normalized.sourceIds = [...new Set(input.sourceIds)].filter(id => allowed.has(id));
      normalized.kind = input.kind === 'labels' ? 'labels' : 'attribution';
      const queued = store.pendingJobs().find(job => job.meetingId === meetingId && job.type === type && job.status === 'queued');
      if (queued) return store.updateJob(queued.id, { input: { sourceIds: [...new Set([...queued.input.sourceIds, ...normalized.sourceIds])], kind: queued.input.kind === 'labels' && normalized.kind === 'labels' ? 'labels' : 'attribution' } });
    }
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

  function refreshSpeakers(meetingId, sourceIds, { kind = 'attribution' } = {}) {
    const meeting = store.getMeeting(meetingId);
    if (!Array.isArray(sourceIds)) throw fail('请提供需要核对的原文。');
    if (!peopleReviewRecords(meeting, sourceLines(meetingId, store.allTranscript(meetingId)), sourceIds, kind).length) return null;
    return submit(meetingId, 'refresh_speakers', { sourceIds, kind });
  }

  return { submit, refreshSpeakers, start, stop };
}
