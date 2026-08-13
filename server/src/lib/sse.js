/**
 * Server-Sent Events helper.
 *
 * Used by chat/quick streaming, council progressive results, and PR job
 * progress. Wrapping it here means the heartbeat, the disconnect handling and
 * the terminal-event contract are written once.
 *
 * Wire contract every stream follows:
 *   event: <name>\ndata: <json>\n\n
 * and exactly one terminal event — `done` or `error` — before the response ends.
 */
import { redact } from "./redact.js";

/** How often to send a comment line so proxies don't close an idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * Take over a response for SSE.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {object} [options]
 * @param {number} [options.heartbeatMs]
 * @returns {{
 *   send: (event: string, data: unknown) => boolean,
 *   comment: (text: string) => void,
 *   done: (data?: unknown) => void,
 *   fail: (error: {code: string, message: string}) => void,
 *   onAbort: (fn: () => void) => void,
 *   get aborted(): boolean,
 *   get closed(): boolean,
 * }}
 */
export function createSseStream(req, res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  let closed = false;
  let aborted = false;
  const abortHandlers = new Set();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Stops nginx buffering the stream into uselessness.
    "X-Accel-Buffering": "no",
    ...(res.getHeader("x-request-id") ? {} : {}),
  });
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, heartbeatMs);
  // Never hold the event loop open for a heartbeat.
  heartbeat.unref?.();

  function cleanup() {
    clearInterval(heartbeat);
  }

  function send(event, data) {
    if (closed) return false;
    const payload = JSON.stringify(redact(data ?? {}));
    res.write(`event: ${event}\ndata: ${payload}\n\n`);
    return true;
  }

  function end() {
    if (closed) return;
    closed = true;
    cleanup();
    res.end();
  }

  req.on("close", () => {
    if (closed) return;
    // Client hung up before we finished — surface it so callers can persist
    // a partial result rather than losing the tokens already generated.
    aborted = true;
    closed = true;
    cleanup();
    for (const fn of abortHandlers) {
      try {
        fn();
      } catch {
        /* an abort handler must never mask the disconnect */
      }
    }
  });

  return {
    send,
    comment: (text) => {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    done: (data) => {
      send("done", data ?? { ok: true });
      end();
    },
    fail: (error) => {
      send("error", { error });
      end();
    },
    onAbort: (fn) => abortHandlers.add(fn),
    get aborted() {
      return aborted;
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Parse an SSE body into events. Test helper — supertest gives us the whole
 * buffered stream, and asserting on parsed events beats regexing raw text.
 *
 * @returns {Array<{event: string, data: any}>}
 */
export function parseSseBody(body) {
  return String(body)
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && !chunk.startsWith(":"))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "message";
      const dataLines = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      const raw = dataLines.join("\n");
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* leave as text */
      }
      return { event, data };
    });
}
