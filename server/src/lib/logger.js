/**
 * Structured JSON logging.
 *
 * Every log line passes through `redact()` before serialisation, so a secret
 * cannot reach stdout even if a caller logs a whole config or an upstream
 * error body verbatim. That guarantee is asserted in tests/unit/redact.test.js.
 */
import pino from "pino";
import { redact } from "./redact.js";

/**
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {boolean} [options.pretty] Human-readable output for local dev.
 * @param {import("stream").Writable} [options.destination] Test seam.
 */
export function createLogger({ level = "info", pretty = false, destination } = {}) {
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
      ...(pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
            },
          }
        : {}),
    },
    destination,
  );
}

/** Shared instance for modules without a request-scoped child logger. */
export const logger = createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
});
