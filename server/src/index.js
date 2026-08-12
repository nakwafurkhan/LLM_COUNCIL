/**
 * Process bootstrap. The only file that opens a port.
 *
 * Order matters: validate config first so a misconfigured deploy dies at boot
 * with a message naming the variable, rather than 500-ing on first request.
 */
import "dotenv/config";

import { loadConfig } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { registerSecretsFromConfig } from "./lib/redact.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { buildApp } from "./app.js";
import { createLlmAdapter } from "./services/llm/index.js";

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

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, chatModel: config.CHAT_MODEL },
      "llm-council listening",
    );
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

    server.close(async (err) => {
      if (err) logger.error({ err }, "error closing http server");
      try {
        await disconnectDb();
      } catch (dbErr) {
        logger.error({ err: dbErr }, "error closing mongo");
      }
      clearTimeout(force);
      process.exit(err ? 1 : 0);
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
