/**
 * Structured JSON logging.
 *
 * Every log line passes through `redact()` before serialisation, so a secret
 * cannot reach stdout even if a caller logs a whole config or an upstream
 * error body verbatim. That guarantee is asserted in tests/unit/redact.test.js.
 */
import { createRequire } from "node:module";

import pino from "pino";
import { redact } from "./redact.js";

/**
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {boolean} [options.pretty] Human-readable output for local dev.
 * @param {import("stream").Writable} [options.destination] Test seam.
 */
export function createLogger({ level = "info", pretty = false, destination } = {}) {
  // Pretty output is a developer nicety. If pino-pretty is missing or fails to
  // load, fall back to JSON rather than refusing to boot — dying because the
  // logs would have been less readable is a terrible trade.
  let prettyTransport = null;
  if (pretty) {
    try {
      createRequire(import.meta.url).resolve("pino-pretty");
      prettyTransport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      };
    } catch {
      // Left null: JSON logs, and the process still starts.
    }
  }

  return pino(
    {
      level,
      base: { service: "llm-council" },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Applied to every object logged, at every level.
      formatters: {
        log: (obj) => redact(obj),
        level: (label) => ({ level: label }),
      },
      hooks: {
        // Scrub interpolated message strings too, not just bound objects.
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === "string" ? redact(a) : a));
          return method.apply(this, scrubbed);
        },
      },
      ...(prettyTransport ? { transport: prettyTransport } : {}),
    },
    destination,
  );
}

/** Shared instance for modules without a request-scoped child logger. */
export const logger = createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
});
