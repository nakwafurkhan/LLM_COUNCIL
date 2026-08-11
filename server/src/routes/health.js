import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { listModels } from '../services/meshClient.js';

export const healthRouter = Router();

const STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: mongoose.connection.readyState === 1,
    env: config.env,
    db: { state: STATES[mongoose.connection.readyState] || 'unknown', name: config.mongo.db },
    mesh: { configured: Boolean(config.mesh.apiKey), baseUrl: config.mesh.baseUrl }
  });
});

/** Explicit check — proves the key works before you spend a council run finding out. */
healthRouter.get('/mesh', async (_req, res) => {
  try {
    const models = await listModels();
    res.json({ ok: true, models: models.length });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, message: err.message });
  }
});
