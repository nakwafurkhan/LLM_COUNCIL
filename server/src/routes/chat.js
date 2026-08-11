import { Router } from 'express';
import { pipelines } from '../services/pipelines/index.js';
import { createStream, createBatcher } from '../services/sse.js';
import { Run } from '../models/Run.js';
import { Setting } from '../models/Setting.js';
import { HOUSE_SYSTEM } from '../services/prompts.js';

export const chatRouter = Router();

const DEFAULTS = {
  quickModel: 'openai/gpt-4o-mini',
  studyModel: 'openai/gpt-4o',
  humanizeModel: 'anthropic/claude-sonnet-4',
  chairModel: 'openai/gpt-4o',
  seats: ['openai/gpt-4o', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct'],
  peerReview: true,
  systemPrompt: HOUSE_SYSTEM,
  voiceSample: '',
  contextTurns: 3
};

/** Stored settings are the source of truth; the request may override per-run. */
async function resolveSettings(overrides = {}) {
  const stored = await Setting.read().catch(() => ({}));
  const merged = { ...DEFAULTS, ...stored, ...overrides };
  merged.seats = (Array.isArray(merged.seats) ? merged.seats : DEFAULTS.seats)
    .map(s => (typeof s === 'string' ? s : s?.model))
    .filter(Boolean);
  return merged;
}

function buildMessages({ prompt, imageUrl, history, settings }) {
  const messages = [];
  if (settings.systemPrompt) messages.push({ role: 'system', content: settings.systemPrompt });

  if (Array.isArray(history) && settings.contextTurns > 0) {
    messages.push(...history.slice(-settings.contextTurns * 2)
      .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role)));
  }

  messages.push({
    role: 'user',
    content: imageUrl
      ? [
          { type: 'text', text: prompt || 'What do you make of this image?' },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }
        ]
      : prompt
  });
  return messages;
}

/**
 * POST /api/chat  →  text/event-stream
 *
 * One connection per run. The server owns the pipeline, so the key never has to
 * reach the browser and a run is persisted even if the tab closes mid-stream.
 */
chatRouter.post('/', async (req, res) => {
  const { mode = 'quick', prompt = '', imageUrl = '', history = [], settings: overrides } = req.body || {};

  const pipeline = pipelines[mode];
  if (!pipeline) return res.status(400).json({ error: { message: `Unknown mode "${mode}"` } });
  if (!prompt.trim() && !imageUrl) return res.status(400).json({ error: { message: 'Prompt is required' } });

  const stream = createStream(res);
  const batch = createBatcher(stream.send);
  const emit = (event, data) => stream.send(event, data);

  /* If the client hangs up we abort upstream immediately — no point paying for
     tokens nobody will read. */
  const controller = new AbortController();
  let clientGone = false;
  req.on('close', () => { clientGone = true; controller.abort(); });

  const started = Date.now();
  try {
    const settings = await resolveSettings(overrides);
    const messages = buildMessages({ prompt, imageUrl, history, settings });

    const result = await pipeline({ prompt, messages, settings, emit, batch, signal: controller.signal });
    batch.flush();

    const run = await Run.create({
      mode,
      prompt,
      imageUrl,
      ms: Date.now() - started,
      status: 'complete',
      ...result
    });

    emit('done', { run: run.toJSON() });
  } catch (err) {
    batch.flush();
    if (!clientGone) {
      emit('error', {
        message: err?.name === 'AbortError' ? 'Stopped.' : (err?.message || 'Run failed'),
        status: err?.status || 500
      });
    }
  } finally {
    stream.close();
  }
});
