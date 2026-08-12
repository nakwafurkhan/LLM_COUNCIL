/**
 * The single terminal error handler.
 *
 * Every failure in the app funnels here. Rules:
 *  - AppError subclasses map to their own status and code.
 *  - Anything else is a 500 with a generic message; the real detail goes to
 *    the log, not the response.
 *  - Stack traces never cross the wire in production.
 *  - Every message is scrubbed by redact() on the way out, so an upstream
 *    error that echoed a key back at us cannot leak through.
 */
import { isAppError } from "../lib/errors.js";
import { redact, redactString } from "../lib/redact.js";
import { logger as defaultLogger } from "../lib/logger.js";

/** Translate errors thrown by libraries into our taxonomy's status codes. */
function inferStatus(err) {
  if (isAppError(err)) return err.status;
  // express.json() body-parser failures
  if (err?.type === "entity.too.large") return 413;
  if (err?.type === "entity.parse.failed") return 400;
  if (err?.status && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  if (err?.name === "CastError") return 400;
  if (err?.name === "ValidationError") return 400; // mongoose
  if (err?.code === 11000) return 409; // duplicate key
  return 500;
}

function inferCode(err, status) {
  if (isAppError(err)) return err.code;
  if (err?.type === "entity.too.large") return "PAYLOAD_TOO_LARGE";
  if (err?.type === "entity.parse.failed") return "MALFORMED_JSON";
  if (err?.code === 11000) return "CONFLICT";
  return status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
}

export function errorHandler({ logger = defaultLogger, isProduction = false } = {}) {
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape.
  return function terminalErrorHandler(err, req, res, next) {
    const status = inferStatus(err);
    const code = inferCode(err, status);
    const exposeMessage = isAppError(err) ? err.expose : status < 500;

    const log = req.log ?? logger;
    const logPayload = { err: redact(err), requestId: req.id, status, code, path: req.path };
    if (status >= 500) log.error(logPayload, "request failed");
    else log.warn(logPayload, "request rejected");

    // Headers already sent means a stream was mid-flight; the SSE layer owns
    // the terminal event, so all we can do is close the socket.
    if (res.headersSent) return req.destroy?.() ?? res.end();

    const body = {
      error: {
        code,
        message: exposeMessage
          ? redactString(err.message || "Request failed")
          : "Something went wrong. Check the server logs with this request id.",
        requestId: req.id,
      },
    };

    if (Array.isArray(err.fields) && err.fields.length) body.error.fields = err.fields;
    if (err.details && exposeMessage) body.error.details = redact(err.details);
    // Stacks are a development affordance only.
    if (!isProduction && status >= 500 && err.stack) {
      body.error.stack = redactString(err.stack).split("\n");
    }

    res.status(status).json(body);
  };
}

/** 404 for anything that reached the end of the router chain. */
export function notFoundHandler() {
  return function notFound(req, res) {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `No route for ${req.method} ${req.path}`,
        requestId: req.id,
      },
    });
  };
}
