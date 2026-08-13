/**
 * Per-request correlation id.
 *
 * Honours an inbound `x-request-id` when it looks sane, otherwise mints one.
 * Echoed on the response and attached to the request-scoped logger so a log
 * line and a client-visible error can be tied together.
 */
import { randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId() {
  return function requestIdMiddleware(req, res, next) {
    const inbound = req.get("x-request-id");
    const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
    req.id = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
