import { Router } from 'express';
import { listModels } from '../services/meshClient.js';

export const modelsRouter = Router();

/* The catalog changes rarely and every settings check would otherwise re-fetch
   a few hundred rows. Ten minutes is long enough to be cheap, short enough that
   a newly added model shows up while you are still looking for it. */
let cache = { at: 0, ids: [], chat: [] };
const TTL_MS = 10 * 60 * 1000;

async function catalog() {
  if (Date.now() - cache.at < TTL_MS && cache.ids.length) return cache;

  const rows = await listModels();
  const ids = rows.map(r => r?.id).filter(Boolean);
  /* Only models that can serve chat completions are valid seats. The flag is
     absent on some rows, so treat "missing" as usable rather than hiding it. */
  const chat = rows
    .filter(r => r?.id && r.supports_completions_api !== false)
    .map(r => r.id);

  cache = { at: Date.now(), ids, chat };
  return cache;
}

modelsRouter.get('/', async (req, res, next) => {
  try {
    const { ids, chat } = await catalog();
    res.json({ count: ids.length, chatCount: chat.length, models: chat });
  } catch (err) { next(err); }
});

/**
 * POST /api/models/validate  { models: [...] }
 * Answers the question that actually matters: are the slugs I have configured
 * real? A wrong slug fails one card at a time, which is a slow way to find out.
 */
modelsRouter.post('/validate', async (req, res, next) => {
  try {
    const wanted = [...new Set((req.body?.models || []).filter(Boolean))];
    const { ids, chat } = await catalog();

    if (!ids.length) {
      return res.json({ checked: false, reason: 'The catalog came back empty.', known: [], unknown: [] });
    }

    const known = new Set(ids);
    const chatSet = new Set(chat);
    res.json({
      checked: true,
      total: ids.length,
      known: wanted.filter(m => known.has(m)),
      unknown: wanted.filter(m => !known.has(m)),
      notChatCapable: wanted.filter(m => known.has(m) && !chatSet.has(m))
    });
  } catch (err) { next(err); }
});
