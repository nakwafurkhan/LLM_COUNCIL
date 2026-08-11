import { streamChat, chat } from '../meshClient.js';
import { CHAIR_SYSTEM, REVIEW_SYSTEM, reviewUser } from '../prompts.js';
import { looseJSON, aggregateReviews } from '../../utils/parse.js';

const LETTERS = 'ABCDEFGHIJ';

/**
 * Stage 1 — every seat answers in parallel, streaming into its own card.
 * A seat that fails records the error and drops out; it never aborts the run.
 */
async function deliberate({ seats, messages, emit, batch, signal }) {
  return Promise.all(seats.map(async (seat, index) => {
    emit('seat', { index, model: seat });
    const started = Date.now();
    let firstTokenMs = 0;
    let text = '';

    try {
      text = await streamChat({
        model: seat,
        messages,
        signal,
        onDelta: (delta) => {
          if (!firstTokenMs) firstTokenMs = Date.now() - started;
          batch.push(`seat:${index}`, delta);
        }
      });
      batch.flush();
      const ms = Date.now() - started;
      emit('seatDone', { index, ms, firstTokenMs, words: text.trim().split(/\s+/).filter(Boolean).length });
      return { index, model: seat, text, ms, firstTokenMs, error: '' };
    } catch (err) {
      batch.flush();
      const message = err.name === 'AbortError' ? 'Stopped.' : err.message;
      emit('seatDone', { index, ms: Date.now() - started, firstTokenMs, words: 0, error: message });
      return { index, model: seat, text: '', ms: Date.now() - started, firstTokenMs, error: message };
    }
  }));
}

/**
 * Stage 2 — blind peer review. Every reviewer sees the same answers relabelled
 * and reshuffled, with no authorship and its own answer unmarked.
 */
async function peerReview({ question, answered, emit, signal }) {
  emit('stage', { stage: 'review', label: 'Anonymous peer review', total: answered.length });

  const reviews = await Promise.all(answered.map(async (reviewer) => {
    const shuffled = [...answered].sort(() => Math.random() - 0.5);
    const labelToIndex = {};
    const blocks = shuffled.map((entry, position) => {
      const label = LETTERS[position];
      labelToIndex[label] = entry.index;
      return `### Response ${label}\n${entry.text}`;
    }).join('\n\n');

    try {
      const raw = await chat({
        model: reviewer.model,
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: reviewUser(question, blocks) }
        ],
        json: true,
        signal
      });
      const parsed = looseJSON(raw) || {};
      return { reviewerIndex: reviewer.index, labelToIndex, scores: parsed.scores };
    } catch {
      /* One reviewer refusing is not fatal — the average just has fewer votes. */
      return { reviewerIndex: reviewer.index, labelToIndex, scores: null };
    }
  }));

  const ranking = aggregateReviews({ reviews, seats: answered });
  emit('review', { ranking });
  return ranking;
}

/** Stage 3 — the chair reads the answers and the rankings, then decides. */
async function synthesise({ chairModel, question, answered, ranking, emit, batch, signal }) {
  emit('stage', { stage: 'chair', label: 'Chairman synthesis' });

  const brief = answered.map((entry, i) => {
    const rank = ranking?.find(r => r.index === entry.index);
    const score = rank && rank.votes ? ` — peer score ${rank.mean.toFixed(1)}/10, ranked #${rank.rank}` : '';
    return `### Member ${i + 1} (${entry.model})${score}\n${entry.text}`;
  }).join('\n\n');

  const critiques = ranking?.length
    ? '\n\nPeer critiques:\n' + ranking.flatMap(r => r.critiques.map(c => `- on ${r.model}: ${c}`)).join('\n')
    : '';

  const text = await streamChat({
    model: chairModel,
    messages: [
      { role: 'system', content: CHAIR_SYSTEM },
      { role: 'user', content: `Question put to the council:\n${question || '(image attached)'}\n\n${brief}${critiques}` }
    ],
    signal,
    onDelta: (delta) => batch.push('chair', delta)
  });
  batch.flush();
  return text;
}

export async function runCouncil({ prompt, messages, settings, emit, batch, signal }) {
  const seats = settings.seats.filter(Boolean);
  emit('stage', { stage: 'deliberation', label: 'Deliberation', total: seats.length });

  const results = await deliberate({ seats, messages, emit, batch, signal });
  const answered = results.filter(r => r.text.trim());

  if (!answered.length) {
    throw Object.assign(new Error('Every seat failed. Check your model slugs in Settings.'), { status: 502 });
  }

  /* A council of one is just Quick with extra steps. */
  let ranking = null;
  if (settings.peerReview && answered.length > 1) {
    ranking = await peerReview({ question: prompt, answered, emit, signal });
  }

  let chair = null;
  if (settings.chairModel && settings.chairModel !== 'none') {
    const text = await synthesise({
      chairModel: settings.chairModel, question: prompt, answered, ranking, emit, batch, signal
    });
    chair = { model: settings.chairModel, text };
  }

  return {
    models: seats,
    seats: results,
    ranking: ranking || undefined,
    chair: chair || undefined
  };
}
