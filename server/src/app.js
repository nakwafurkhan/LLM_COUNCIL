/**
 * Express application factory.
 *
 * ARCHITECTURAL INVARIANT: this file never calls listen(), never connects to
 * Mongo, never reads the clock at module scope, and has no side effects on
 * import. That is precisely what lets integration tests build a real app with
 * a fake LLM adapter and drive it through supertest with no ports and no
 * network. `index.js` is the only file allowed to open a port.
 *
 * Dependencies come in as arguments, not imports, so a test can swap any of
 * them without module mocking.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import express from "express";
import helmet from "helmet";
import cors from "cors";

import { requestId } from "./middleware/requestId.js";
import { createRateLimiters } from "./middleware/rateLimit.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { conversationsRouter } from "./routes/conversations.js";
import { councilRouter } from "./routes/council.js";
import { prRouter } from "./routes/pr.js";
import { logger as defaultLogger } from "./lib/logger.js";

/**
 * @param {object} deps
 * @param {object} deps.config   Parsed config from config/env.js.
 * @param {object} [deps.llm]    LLM adapter. Tests pass the fake.
 * @param {object} [deps.logger]
 * @returns {import("express").Express}
 */
export function buildApp({ config, llm, logger = defaultLogger, codePr }) {
  const app = express();
  const startedAt = Date.now();

  // Behind a proxy the rate limiter must see the real client IP.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId());
  app.use((req, _res, next) => {
    req.log = logger.child({ requestId: req.id });
    next();
  });

  app.use(
    helmet({
      // The API serves JSON and SSE; the strict default CSP would break the
      // Vite dev client without adding anything here.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header.
        if (!origin) return callback(null, true);
        callback(null, config.CORS_ORIGINS.includes(origin));
      },
      credentials: true,
      exposedHeaders: ["x-request-id"],
    }),
  );

  app.use(express.json({ limit: config.BODY_LIMIT }));

  const limiters = createRateLimiters(config);
  app.use("/api", limiters.global);

  // Shared context for route modules, so no route reaches for a global.
  const ctx = { config, llm, logger, limiters, startedAt, codePr };

  app.use("/api", healthRouter(ctx));

  // Chat and Quick share this router; the mode lives on the conversation.
  app.use("/api", conversationsRouter(ctx));

  app.use("/api", councilRouter(ctx));
  app.use("/api", prRouter(ctx));

  // Serve the built client when it exists (npm run build writes it here).
  // express.static resolves and contains paths itself — the old server's
  // hand-rolled path.join was what allowed traversal out of public/.
  const clientDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "public",
  );
  if (fs.existsSync(path.join(clientDir, "index.html"))) {
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    // SPA fallback for client-side routes, but never for /api: an unknown
    // API path must stay a JSON 404 rather than silently returning HTML.
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.use(notFoundHandler());
  app.use(errorHandler({ logger, isProduction: config.isProduction }));

  return app;
}
