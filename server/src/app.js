import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config/env.js';
import { api } from './routes/index.js';
import { notFound, errorHandler } from './middleware/errors.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  /* SSE and streamed proxying must not be buffered or compressed. */
  app.set('etag', false);

  app.use(cors({
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    credentials: false
  }));

  /* Humanizer input and study topics can be long; the default 100kb is stingy. */
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', api);

  /* In production the built client is served from the same origin, which is why
     none of the CORS pain from the previous version applies here. */
  if (existsSync(config.publicDir)) {
    app.use(express.static(config.publicDir, { maxAge: '1h', index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(join(config.publicDir, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
