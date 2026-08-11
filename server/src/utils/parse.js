/**
 * Parsing lives on the server so the client renders structured data and never
 * re-derives it. These are pure functions — they are what the unit tests cover.
 */

/** Pull the first JSON object out of a reply that may be fenced or wrapped in prose. */
export function looseJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* try once more below */ }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

/** Split "## SECTION" documents into a map keyed by section name. */
export function splitSections(text = '') {
  const out = {};
  let current = null;
  let buffer = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+([A-Z][A-Z ]{2,})\s*$/);
    if (heading) {
      if (current) out[current] = buffer.join('\n').trim();
      current = heading[1].trim();
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) out[current] = buffer.join('\n').trim();
  return out;
}

export const toBullets = (src = '') =>
  src.split('\n').map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);

/** "question :: answer" per line. */
export function parseFlashcards(src = '') {
  return src.split('\n')
    .map(l => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .map(line => {
      const i = line.indexOf('::');
      if (i < 0) return null;
      return { q: line.slice(0, i).trim(), a: line.slice(i + 2).trim() };
    })
    .filter(c => c && c.q && c.a);
}

/** Numbered questions, each followed by a line starting "Answer:". */
export function parseQuiz(src = '') {
  const items = [];
  let current = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const answer = line.match(/^\**answer\**\s*[:\-]\s*(.+)$/i);
    if (answer) {
      if (current) { current.a = answer[1].trim(); items.push(current); current = null; }
      continue;
    }
    const question = line.match(/^(?:\d+[.)]|[-*])\s*(.+)$/);
    if (question) {
      if (current) items.push(current);
      current = { q: question[1].replace(/^\**|\**$/g, '').trim(), a: '' };
    } else if (current && !current.a) {
      current.q += ' ' + line;
    }
  }
  if (current) items.push(current);
  return items.filter(i => i.q);
}

export function parseStudyPack(raw = '') {
  const s = splitSections(raw);
  return {
    orient: s.ORIENT || '',
    map: s.MAP || '',
    core: s.CORE || '',
    misconceptions: s.MISCONCEPTIONS || '',
    example: s.EXAMPLE || '',
    goDeeper: s['GO DEEPER'] || '',
    flashcards: parseFlashcards(s.FLASHCARDS),
    quiz: parseQuiz(s.QUIZ),
    raw
  };
}

export function parseHumanized(raw = '') {
  const s = splitSections(raw);
  return {
    draft: s.DRAFT || '',
    tells: toBullets(s.TELLS),
    /* If the model skipped the audit structure, the draft is still a usable
       answer — better to show something than to show nothing. */
    final: s.FINAL || s.DRAFT || raw,
    changes: toBullets(s.CHANGES),
    raw
  };
}

/**
 * Aggregate peer-review scores, discarding every reviewer's vote on its own
 * answer. A model rating itself is not evidence.
 */
export function aggregateReviews({ reviews, seats }) {
  const totals = new Map(seats.map(s => [s.index, {
    index: s.index, model: s.model, sum: 0, votes: 0, critiques: []
  }]));

  for (const review of reviews) {
    const rows = review?.scores;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const target = review.labelToIndex[String(row.label || '').trim().toUpperCase()];
      if (target === undefined || target === review.reviewerIndex) continue;
      const entry = totals.get(target);
      if (!entry) continue;
      const nums = [row.accuracy, row.reasoning, row.usefulness]
        .map(Number)
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 10);
      if (!nums.length) continue;
      entry.sum += nums.reduce((a, b) => a + b, 0) / nums.length;
      entry.votes += 1;
      if (row.critique) entry.critiques.push(String(row.critique).trim());
    }
  }

  return [...totals.values()]
    .map(e => ({
      index: e.index,
      model: e.model,
      mean: e.votes ? Number((e.sum / e.votes).toFixed(2)) : 0,
      votes: e.votes,
      critiques: e.critiques
    }))
    .sort((a, b) => b.mean - a.mean)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}
