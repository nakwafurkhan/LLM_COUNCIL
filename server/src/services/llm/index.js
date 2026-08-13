/**
 * Adapter selection and the model allowlist.
 *
 * `createLlmAdapter` is what index.js and the tests both call. The fake is
 * chosen by config, never by an import-time branch, so production code has no
 * knowledge of test doubles.
 */
import { ValidationError } from "../../lib/errors.js";
import { logger as defaultLogger } from "../../lib/logger.js";
import { createMeshAdapter } from "./meshAdapter.js";

export { createMeshAdapter } from "./meshAdapter.js";

/**
 * Resolve the model to use for a request.
 *
 * A client may ask for a model, but only from the server's allowlist —
 * forwarding an arbitrary client string upstream would let anyone bill us for
 * whatever the router happens to expose.
 *
 * @param {string|undefined} requested
 * @param {string} fallback  The mode's configured default.
 * @param {string[]} allowed
 */
export function resolveModel(requested, fallback, allowed) {
  if (!requested) return fallback;
  if (!allowed.includes(requested)) {
    throw new ValidationError(`Model "${requested}" is not permitted`, [
      {
        path: "model",
        message: `must be one of: ${allowed.join(", ")}`,
      },
    ]);
  }
  return requested;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} [deps.logger]
 * @returns {Promise<object>} adapter implementing { askModel, streamModel, listModels }
 */
export async function createLlmAdapter({ config, logger = defaultLogger }) {
  if (config.USE_FAKE_LLM) {
    if (config.isProduction) {
      // A fake adapter in production would silently serve fabricated answers
      // to real users. Refuse to boot rather than degrade quietly.
      throw new Error("USE_FAKE_LLM must not be enabled when NODE_ENV=production");
    }
    logger.warn("using the FAKE llm adapter — no real model calls will be made");
    // Imported dynamically so the fixture is never resolved in a normal boot.
    const { createFakeLlm } = await import("../../../tests/fixtures/fakeLlm.js");
    return createFakeLlm();
  }

  return createMeshAdapter({ config, logger });
}
