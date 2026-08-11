import { Router } from 'express';
import mongoose from 'mongoose';
import { Run } from '../models/Run.js';

export const runsRouter = Router();

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/** GET /api/runs — summaries only; answer bodies are the bulk of a document. */
runsRouter.get('/', async (req, res, next) => {
  try {
    const { limit, mode, q } = req.query;
    res.json({ runs: await Run.listSummaries({ limit, mode, q }) });
  } catch (err) { next(err); }
});

runsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id' } });
    const run = await Run.findById(req.params.id);
    if (!run) return res.status(404).json({ error: { message: 'No such run' } });
    res.json(run.toJSON());
  } catch (err) { next(err); }
});

runsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id' } });
    const { deletedCount } = await Run.deleteOne({ _id: req.params.id });
    res.json({ deleted: deletedCount > 0 });
  } catch (err) { next(err); }
});

runsRouter.delete('/', async (_req, res, next) => {
  try {
    const { deletedCount } = await Run.deleteMany({});
    res.json({ deleted: deletedCount });
  } catch (err) { next(err); }
});
