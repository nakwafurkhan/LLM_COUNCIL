/**
 * Health and readiness.
 *
 * `/api/health` reports process, Mongo and config sanity. It deliberately
 * reports *which* optional subsystems are unconfigured (Code+PR needs GitHub
 * settings) without ever echoing a value — the boolean is the whole answer.
 */
import { Router } from "express";
import { dbStatus, pingDb } from "../db/connect.js";

export function healthRouter({ config, startedAt = Date.now() }) {
  const router = Router();

  router.get("/health", async (req, res) => {
    const db = dbStatus();
    const reachable = db.ok ? await pingDb() : false;

    const checks = {
      process: { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
      mongo: { ok: reachable, state: db.state, database: db.name },
      config: {
        ok: true,
        // Presence only. Never the value.
        meshApiKeyConfigured: Boolean(config.MESH_API_KEY),
        githubConfigured: Boolean(
          config.GITHUB_TOKEN && config.GITHUB_OWNER && config.GITHUB_REPO,
        ),
        repoConfigured: Boolean(config.REPO_LOCAL_PATH),
        fakeLlm: config.USE_FAKE_LLM,
      },
      models: {
        ok: true,
        chat: config.CHAT_MODEL,
        quick: config.QUICK_MODEL,
        council: config.COUNCIL_MODELS,
        chairman: config.CHAIRMAN_MODEL,
      },
    };

    const ok = checks.process.ok && checks.mongo.ok;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "2.0.0",
      requestId: req.id,
      checks,
    });
  });

  return router;
}
