/**
 * Builds a real app wired to the fake adapter.
 *
 * Uses the same loadConfig() the server boots with, so a config change that
 * would break production breaks the tests too.
 */
import { loadConfig } from "../../src/config/env.js";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/lib/logger.js";
import { createFakeLlm } from "./fakeLlm.js";

export const TEST_ENV = {
  MESH_API_KEY: "rsk_test_key_never_real_000000",
  MONGODB_URI: "mongodb://127.0.0.1:27017",
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  CHAT_MODEL: "openai/gpt-4o",
  QUICK_MODEL: "openai/gpt-4o-mini",
  COUNCIL_MODELS: "openai/gpt-4o,openai/gpt-4o-mini,anthropic/claude-3-5-sonnet",
  CHAIRMAN_MODEL: "openai/gpt-4o",
};

/**
 * @param {object} [options]
 * @param {Record<string,string>} [options.env]   Overrides merged into TEST_ENV.
 * @param {object} [options.llm]                  Pre-scripted fake adapter.
 */
export function makeTestApp({ env = {}, llm = createFakeLlm() } = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const logger = createLogger({ level: "silent" });
  const app = buildApp({ config, llm, logger });
  return { app, config, llm };
}
