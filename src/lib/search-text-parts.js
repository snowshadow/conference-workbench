export function searchTextParts(text, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, matched: false, start: 0 }];
  const folded = text.toLocaleLowerCase();
  // Lowercasing can expand a character (such as İ). Keep the original spelling
  // and offsets so a later match does not highlight the neighbouring character.
  let offsets;
  if (folded.length !== text.length) {
    offsets = [];
    let start = 0;
    for (const character of text) {
      const end = start + character.length;
      for (let i = 0; i < character.toLocaleLowerCase().length; i++) offsets.push({ start, end });
      start = end;
    }
  }
  const parts = [];
  let cursor = 0, from = 0, found;
  while ((found = folded.indexOf(needle, from)) !== -1) {
    from = found + needle.length;
    const start = offsets ? offsets[found].start : found;
    const end = offsets ? offsets[from - 1].end : from;
    if (end <= cursor) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), matched: false, start: cursor });
    parts.push({ text: text.slice(Math.max(cursor, start), end), matched: true, start: Math.max(cursor, start) });
    cursor = end;
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor), matched: false, start: cursor });
  return parts;
}
