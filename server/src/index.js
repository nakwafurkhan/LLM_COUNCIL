/**
 * Process bootstrap. The only file that opens a port.
 *
 * Order matters: validate config first so a misconfigured deploy dies at boot
 * with a message naming the variable, rather than 500-ing on first request.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { loadConfig, envFileCandidates } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { registerSecretsFromConfig } from "./lib/redact.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { buildApp } from "./app.js";
import { createLlmAdapter } from "./services/llm/index.js";

/**
 * Load .env from the repo root, not from the current working directory.
 *
 * `npm run dev --workspace server` starts this process with cwd set to
 * `server/`, so a bare `dotenv/config` import looked for `server/.env` and
 * silently found nothing — the root `.env` that .env.example tells you to
 * create was never read, and the server died claiming required variables were
 * missing when they were sitting right there. Resolving from this file's own
 * location makes the load independent of where the process was started.
 *
 * dotenv does not overwrite variables that are already set, so the root file
 * wins over a per-package one, and a real environment variable beats both.
 */
for (const candidate of envFileCandidates(path.dirname(fileURLToPath(import.meta.url)))) {
  dotenv.config({ path: candidate });
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // No logger yet — and this must be readable in a container log tail.
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  // Do this before anything else can log: it arms redact() with the real
  // secret values so they cannot appear in any subsequent line.
  registerSecretsFromConfig(config);

  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: !config.isProduction,
  });

  await connectDb(config, { logger });

  const llm = await createLlmAdapter({ config, logger });
  const app = buildApp({ config, llm, logger });

  let listening = false;

  const server = app.listen(config.PORT, () => {
    listening = true;
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, chatModel: config.CHAT_MODEL },
      "llm-council listening",
    );
  });

  /**
   * A busy port is an ordinary startup condition, not a crash.
   *
   * Without this handler the error reaches `uncaughtException`, which logs a
   * FATAL with a stack trace and then tries to shut down a server that never
   * started — producing a second, misleading ERR_SERVER_NOT_RUNNING on top of
   * the first. Two alarming errors where the useful message is one line.
   */
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nPort ${config.PORT} is already in use.\n\n` +
          `Something else is listening there — most often an earlier \`npm run dev\`\n` +
          `that did not exit. Free it, or pick another port:\n\n` +
          `  lsof -ti:${config.PORT} | xargs kill      # free the port (macOS/Linux)\n` +
          `  PORT=8788 npm run dev                     # or use a different one\n`,
      );
      process.exit(1);
    }
    if (err.code === "EACCES") {
      console.error(
        `\nNot allowed to bind port ${config.PORT}.\n\n` +
          `Ports below 1024 need elevated privileges. Set PORT to something above\n` +
          `1024 in your .env.\n`,
      );
      process.exit(1);
    }

    logger.fatal({ err, port: config.PORT }, "http server error");
    process.exit(1);
  });

  // Long-lived SSE streams must be allowed to drain, but not forever.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 20_000);
    force.unref();

    const closeDbAndExit = async (code) => {
      try {
        await disconnectDb();
      } catch (dbErr) {
        logger.error({ err: dbErr }, "error closing mongo");
      }
      clearTimeout(force);
      process.exit(code);
    };

    // Closing a server that never bound throws ERR_SERVER_NOT_RUNNING, which
    // is noise stacked on whatever actually went wrong.
    if (!listening) return closeDbAndExit(1);

    server.close(async (err) => {
      if (err) logger.error({ err }, "error closing http server");
      await closeDbAndExit(err ? 1 : 0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
