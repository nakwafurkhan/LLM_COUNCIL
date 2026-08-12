/**
 * Per-IP rate limiting.
 *
 * Tiered deliberately: council and PR routes each cost real money and real
 * compute upstream, so they get their own much stricter buckets rather than
 * sharing the global one.
 *
 * Errors are emitted through our own taxonomy so the response shape matches
 * every other error in the API.
 */
import rateLimit from "express-rate-limit";
import { RateLimitError } from "../lib/errors.js";

function buildLimiter({ windowMs, max, name }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Route through the terminal error handler instead of express-rate-limit's
    // own plaintext response, so clients get one consistent error shape.
    handler: (_req, _res, next) => {
      next(new RateLimitError(`Rate limit exceeded for ${name}. Try again in a moment.`));
    },
    // Health checks must never be throttled.
    skip: (req) => req.path === "/api/health",
  });
}

export function createRateLimiters(config) {
  const windowMs = config.RATE_LIMIT_WINDOW_MS;
  return {
    global: buildLimiter({ windowMs, max: config.RATE_LIMIT_MAX, name: "the API" }),
    council: buildLimiter({
      windowMs,
      max: config.RATE_LIMIT_COUNCIL_MAX,
      name: "council runs",
    }),
    pr: buildLimiter({ windowMs, max: config.RATE_LIMIT_PR_MAX, name: "PR jobs" }),
  };
}
