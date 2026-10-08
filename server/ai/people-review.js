import { attributedPeople, groundedPeopleText, validPeopleReferences } from './people.js';
import { evidenceFor } from './retrieval.js';

/** Check one returned field against its original source scope, without publishing. */
export function checkPeopleReview(record, result, byId, meeting) {
  const reject = (reason, code, extra = {}) => ({ issue: { recordId: record.id, reason, code, ...extra } });
  if (!result) return reject('incomplete', 'missing_text');
  let text = record.text;
  if (result.unchanged !== true) {
    if (Array.isArray(result.edits) && result.edits.length) {
      for (const edit of result.edits) {
        const start = typeof edit.from === 'string' && edit.from.length ? text.indexOf(edit.from) : -1;
        if (start === -1 || typeof edit.to !== 'string' || text.indexOf(edit.from, start + 1) !== -1) return reject('incomplete', 'ambiguous_edit');
        text = text.slice(0, start) + edit.to + text.slice(start + edit.from.length);
      }
    } else if (result.text?.trim()) text = result.text.trim();
    else return reject('incomplete', 'missing_text');
    if (!text.trim()) return reject('incomplete', 'missing_text');
  }
  const permitted = new Map(record.evidenceIds.map(id => [id, byId.get(id)]));
  const citations = result.evidence === undefined && result.unchanged === true ? record.evidenceIds.map(id => ({ id })) : result.evidence;
  if (!citations?.length) return reject('evidence', 'missing_evidence');
  const evidence = new Map();
  for (const item of citations) {
    const source = permitted.get(item.id);
    if (!source) return reject('evidence', 'unknown_source', { sourceId: item.id });
    // Old clients may still supply quotes. Check them, but new replies only
    // select IDs; the source text and revision always come from local storage.
    if (item.quote !== undefined && !evidenceFor({ evidence: [item] }, permitted)) return reject('evidence', 'invalid_quote', { sourceId: item.id });
    evidence.set(source.id, { id: source.id, quote: source.text, revision: source.revision });
  }
  const sources = [...evidence.values()];
  if (!validPeopleReferences(text, sources, permitted, meeting)) return reject('attribution', 'unsupported_person');
  if (record.field === 'markdown') {
    const links = value => [...value.matchAll(/#transcript:([^\s)]+)/g)].map(match => match[1]).sort();
    if (JSON.stringify(links(record.text)) !== JSON.stringify(links(text))) return reject('links', 'changed_links');
  }
  const attribution = result.unchanged === true && result.participantIds === undefined ? { ...result, participantIds: record.participantIds } : result;
  return { update: { record, text: groundedPeopleText(text, sources, permitted, meeting), participantIds: attributedPeople(attribution, sources, permitted, meeting) } };
}
