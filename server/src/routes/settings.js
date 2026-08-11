import { Router } from 'express';
import { Setting } from '../models/Setting.js';
import { scrubSecrets } from '../utils/scrub.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try { res.json(await Setting.read()); } catch (err) { next(err); }
});

/* Belt and braces: the client omits the key, and scrubSecrets drops it again. */
settingsRouter.put('/', async (req, res, next) => {
  try { res.json(await Setting.write(scrubSecrets(req.body || {}))); } catch (err) { next(err); }
});
