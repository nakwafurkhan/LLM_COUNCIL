/**
 * Translating provider failures into our taxonomy.
 *
 * Kept separate from the adapter so the classification rules can be unit
 * tested against synthetic errors without standing up an HTTP layer.
 */
import { UpstreamError, TimeoutError, ValidationError } from "../../lib/errors.js";
import { redactString } from "../../lib/redact.js";

/** Status codes worth trying again. Everything else is our fault, not theirs. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Node/undici network failures that are transient by nature. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export function statusOf(err) {
  return err?.status ?? err?.response?.status ?? err?.statusCode ?? null;
}

/**
 * Should this failure be retried?
 *
 * A 400 means we sent something wrong — retrying just burns budget and
 * latency to get the same answer. A 429 or 503 means try later.
 */
export function isRetryable(err) {
  if (err?.name === "AbortError") return false; // caller gave up, or we timed out
  const status = statusOf(err);
  if (status != null) return RETRYABLE_STATUS.has(status);
  if (err?.code && RETRYABLE_CODES.has(err.code)) return true;
  // An unclassifiable error with no status is usually a socket problem.
  return err instanceof TypeError === false && !status && Boolean(err?.code);
}

/** Honour Retry-After when the provider tells us how long to wait. */
export function retryAfterMs(err) {
  const header =
    err?.headers?.["retry-after"] ??
    err?.response?.headers?.get?.("retry-after") ??
    err?.response?.headers?.["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Map a provider error onto our taxonomy.
 *
 * Every message is scrubbed: provider errors routinely echo the request back,
 * and that request carried an Authorization header.
 */
export function toAppError(err, { model, timeoutMs } = {}) {
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    return new TimeoutError(`Model ${model} did not respond within ${timeoutMs}ms`, {
      cause: err,
    });
  }

  const status = statusOf(err);
  const raw = redactString(err?.message || "unknown provider error");

  if (status === 400 || status === 422) {
    return new ValidationError(`Provider rejected the request for ${model}: ${raw}`, [], {
      cause: err,
    });
  }
  if (status === 401 || status === 403) {
    // Deliberately vague to the caller: the detail is a config problem, and
    // the raw text may quote the credential.
    return new UpstreamError(
      `Provider rejected our credentials (${status}). Check MESH_API_KEY.`,
      { cause: err },
    );
  }
  if (status === 404) {
    return new UpstreamError(`Model ${model} is not available upstream`, { cause: err });
  }

  return new UpstreamError(`Model ${model} failed: ${raw}`, {
    cause: err,
    details: { status: status ?? undefined },
  });
}
