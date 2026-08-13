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

// gpt-4o serves as both the council chairman and the humanizer, so its reply
// branches on what the prompt is actually asking for.
const councilChairmanReply = JSON.stringify({
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
});

const humanizerDraft = "The tool speeds up the boring parts. Not architecture.";
const humanizerAudit = JSON.stringify({
  notes: ["The second fragment is abrupt", "No point of view anywhere"],
});
const humanizerFinal = "The tool speeds up the boring parts. It won't help with architecture.";

/**
 * gpt-4o is the chat model, a council member, the council chairman AND the
 * humanizer, so a single canned reply cannot serve them all — a council member
 * answering with the chairman's JSON made the same text appear twice on screen
 * and broke a strict-mode locator. Branch on the system prompt of each caller.
 */
llm.script("openai/gpt-4o", {
  content: (messages) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const prompt = messages.map((m) => m.content).join("\n");

    if (prompt.includes("What makes the text below so obviously AI generated?")) {
      return humanizerAudit;
    }
    if (system.includes("You are revising text")) return humanizerFinal;
    if (system.includes("removes the signs of AI-generated writing")) return humanizerDraft;
    if (system.includes("chairman of a council")) return councilChairmanReply;
    if (system.includes("one member of a council")) return "A considered first opinion.";
    return "The chairman is speaking now.";
  },
  chunkDelayMs: 5,
});
llm.script("openai/gpt-4o-mini", { content: "A fast, terse answer.", chunkDelayMs: 5 });
llm.script("anthropic/claude-3-5-sonnet", { content: "A considered third opinion." });

const app = buildApp({ config, llm, logger: createLogger({ level: "silent" }) });

app.listen(PORT, () => {
  // Playwright waits for this port; the log is for a human debugging a failure.
  console.warn(`e2e server listening on http://127.0.0.1:${PORT}`);
});
