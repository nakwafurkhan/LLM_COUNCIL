/**
 * One error taxonomy for the whole server.
 *
 * Routes and services throw these; the terminal error handler is the only
 * place that turns them into a status code. No route calls res.status(500).
 */

export class AppError extends Error {
  /**
   * @param {string} message  Safe to show a caller — never interpolate secrets.
   * @param {object} [options]
   * @param {object} [options.details] Structured extras (field lists, upstream status).
   * @param {Error}  [options.cause]
   */
  constructor(message, { details, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  /** HTTP status this maps to. Subclasses override. */
  get status() {
    return 500;
  }

  /** Stable machine-readable code for clients to branch on. */
  get code() {
    return "INTERNAL_ERROR";
  }

  /**
   * True when the message is safe to send verbatim to a client.
   * Anything false gets a generic message in production.
   */
  get expose() {
    return this.status < 500;
  }
}

export class ValidationError extends AppError {
  /** @param {Array<{path: string, message: string}>} [fields] */
  constructor(message = "Request validation failed", fields = [], options = {}) {
    super(message, { ...options, details: { fields } });
    this.fields = fields;
  }
  get status() {
    return 400;
  }
  get code() {
    return "VALIDATION_ERROR";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", options = {}) {
    super(message, options);
  }
  get status() {
    return 404;
  }
  get code() {
    return "NOT_FOUND";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicts with an existing resource", options = {}) {
    super(message, options);
  }
  get status() {
    return 409;
  }
  get code() {
    return "CONFLICT";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", options = {}) {
    super(message, options);
  }
  get status() {
    return 429;
  }
  get code() {
    return "RATE_LIMITED";
  }
}

export class TimeoutError extends AppError {
  constructor(message = "Upstream request timed out", options = {}) {
    super(message, options);
  }
  get status() {
    return 504;
  }
  get code() {
    return "TIMEOUT";
  }
  get expose() {
    return true;
  }
}

export class UpstreamError extends AppError {
  constructor(message = "Upstream provider failed", options = {}) {
    super(message, options);
  }
  get status() {
    return 502;
  }
  get code() {
    return "UPSTREAM_ERROR";
  }
  get expose() {
    return true;
  }
}

/** True for any error this codebase deliberately raised. */
export function isAppError(err) {
  return err instanceof AppError;
}
