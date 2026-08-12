/**
 * Typed fetch wrapper and SSE helper.
 *
 * All API calls go through `apiFetch`. Errors from the server's
 * `{ error: { code, message, requestId, fields? } }` envelope are
 * surfaced as an Error with `.code` and `.fields` properties.
 *
 * SSE helper works over POST (EventSource cannot do that).
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(message, code, fields, requestId) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields ?? null;
    this.requestId = requestId ?? null;
  }
}

export async function apiFetch(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new ApiError(`HTTP ${res.status}`, "HTTP_ERROR");
    }
    const err = payload?.error ?? {};
    throw new ApiError(
      err.message ?? `HTTP ${res.status}`,
      err.code ?? "UNKNOWN",
      err.fields,
      err.requestId,
    );
  }

  if (res.status === 204) return null;

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

/**
 * SSE helper for POST requests.
 *
 * @param {string} path - e.g. "/council"
 * @param {object} body - JSON body
 * @param {object} callbacks - { onEvent(eventName, data), onError(err), onDone() }
 * @returns {function} abort — call to cancel
 */
export function ssePost(path, body, { onEvent, onError, onDone }) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name !== "AbortError") onError?.(err);
      return;
    }

    if (!res.ok) {
      let payload;
      try {
        payload = await res.json();
      } catch {
        onError?.(new ApiError(`HTTP ${res.status}`, "HTTP_ERROR"));
        return;
      }
      const e = payload?.error ?? {};
      onError?.(new ApiError(e.message ?? `HTTP ${res.status}`, e.code ?? "UNKNOWN", e.fields));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const parseLine = (lines) => {
      let eventName = "message";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) return;
      const raw = dataLines.join("\n");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      onEvent?.(eventName, parsed);
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE messages are separated by double newlines
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split(/\r?\n/).filter((l) => l.length > 0);
          if (lines.length > 0) parseLine(lines);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") onError?.(err);
      return;
    }

    onDone?.();
  })();

  return () => controller.abort();
}
