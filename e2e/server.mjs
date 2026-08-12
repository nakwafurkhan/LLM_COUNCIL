/**
 * E2E bootstrap.
 *
 * Starts an in-memory Mongo and the real server with the fake LLM adapter, on
 * one origin serving the built client. Playwright's webServer runs this.
 *
 * Deliberately not `src/index.js`: E2E must never depend on a real MeshAPI key
 * or a real database, and this keeps that guarantee visible in one file.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { loadConfig } from "../server/src/config/env.js";
import { buildApp } from "../server/src/app.js";
import { createLogger } from "../server/src/lib/logger.js";
import { createFakeLlm } from "../server/tests/fixtures/fakeLlm.js";

const PORT = Number(process.env.E2E_PORT ?? 8788);

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: "llm_council_e2e" });

const config = loadConfig({
  MESH_API_KEY: "rsk_e2e_fake_key_000000000000",
  MONGODB_URI: mongo.getUri(),
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  PORT: String(PORT),
  USE_FAKE_LLM: "true",
});

const llm = createFakeLlm();

// Scripted so assertions can be exact rather than "some text appeared".
llm.script("openai/gpt-4o", {
  content: JSON.stringify({
    answer: "The council has synthesised an answer.",
    disagreements: [
      {
        claim: "whether to use Postgres",
        positions: [
          { model: "openai/gpt-4o", stance: "yes" },
          { model: "openai/gpt-4o-mini", stance: "no" },
        ],
      },
    ],
    confidence: "medium",
    confidenceNote: "Members disagreed on storage.",
  }),
  chunks: ["The chairman ", "is speaking ", "now."],
  chunkDelayMs: 10,
});
llm.script("openai/gpt-4o-mini", { content: "A fast, terse answer.", chunkDelayMs: 5 });
llm.script("anthropic/claude-3-5-sonnet", { content: "A considered third opinion." });

const app = buildApp({ config, llm, logger: createLogger({ level: "silent" }) });

app.listen(PORT, () => {
  // Playwright waits for this port; the log is for a human debugging a failure.
  console.warn(`e2e server listening on http://127.0.0.1:${PORT}`);
});
