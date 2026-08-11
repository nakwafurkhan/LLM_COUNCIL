import { config } from '../config/env.js';

/**
 * The only place that talks to the Mesh gateway. Everything else in the server
 * goes through these four functions, so auth, timeouts and error shape are
 * decided once.
 */

export class MeshError extends Error {
  constructor(message, status = 502, requestId = '') {
    super(message);
    this.name = 'MeshError';
    this.status = status;
    this.requestId = requestId;
  }
}

function headers() {
  if (!config.mesh.apiKey) {
    throw new MeshError('MESH_API_KEY is not configured on the server.', 500);
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.mesh.apiKey}`
  };
}

async function toError(res) {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    message = body?.error?.message || message;
  } catch { /* non-JSON error body */ }
  return new MeshError(message, res.status, res.headers.get('x-request-id') || '');
}

/** Caller-supplied signal, plus our own timeout, without clobbering either. */
function withTimeout(signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Upstream timeout')), config.mesh.timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/**
 * Stream a chat completion. Calls onDelta(text) per token and resolves with the
 * full text. SSE frames are split on the wire, so we buffer until a newline.
 */
export async function streamChat({ model, messages, signal, onDelta }) {
  const t = withTimeout(signal);
  try {
    const res = await fetch(`${config.mesh.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      signal: t.signal,
      body: JSON.stringify({ model, messages, stream: true })
    });
    if (!res.ok) throw await toError(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) { text += delta; onDelta?.(delta); }
        } catch { /* keep-alive or partial frame */ }
      }
    }
    return text;
  } finally {
    t.done();
  }
}

/** One-shot completion. `json: true` asks for strict JSON, downgrading if the model refuses. */
export async function chat({ model, messages, signal, json = false }) {
  const t = withTimeout(signal);
  try {
    const body = { model, messages };
    if (json) body.response_format = { type: 'json_object' };

    let res = await fetch(`${config.mesh.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(), signal: t.signal, body: JSON.stringify(body)
    });

    if (!res.ok && json && (res.status === 400 || res.status === 422)) {
      delete body.response_format;
      res = await fetch(`${config.mesh.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: headers(), signal: t.signal, body: JSON.stringify(body)
      });
    }
    if (!res.ok) throw await toError(res);

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    t.done();
  }
}

export async function listModels({ signal } = {}) {
  const t = withTimeout(signal);
  try {
    const res = await fetch(`${config.mesh.baseUrl}/v1/models`, { headers: headers(), signal: t.signal });
    if (!res.ok) throw await toError(res);
    const data = await res.json();
    return data.data || [];
  } finally {
    t.done();
  }
}

export async function webSearch({ query, maxResults = 12, signal }) {
  const t = withTimeout(signal);
  try {
    const res = await fetch(`${config.mesh.baseUrl}/v1/web/search`, {
      method: 'POST',
      headers: headers(),
      signal: t.signal,
      body: JSON.stringify({ query, max_results: maxResults })
    });
    if (!res.ok) throw await toError(res);
    const data = await res.json();
    return data.results || [];
  } finally {
    t.done();
  }
}
