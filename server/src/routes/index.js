import { Router } from 'express';
import { chatRouter } from './chat.js';
import { runsRouter } from './runs.js';
import { settingsRouter } from './settings.js';
import { healthRouter } from './health.js';
import { imagesRouter } from './images.js';
import { modelsRouter } from './models.js';

export const api = Router();

api.use('/health', healthRouter);
api.use('/chat', chatRouter);
api.use('/runs', runsRouter);
api.use('/settings', settingsRouter);
api.use('/images', imagesRouter);
api.use('/models', modelsRouter);
