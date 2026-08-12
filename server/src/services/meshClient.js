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

/* TLS-interception codes. Node keeps its own CA list and ignores the macOS
   Keychain, so a corporate proxy, VPN or antivirus doing HTTPS inspection
   breaks Node while every browser on the machine keeps working. undici buries
   the real reason in err.cause, and "fetch failed" tells you nothing. */
const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED'
]);

export function explainNetworkError(err) {
  if (err instanceof MeshError) return err;

  const code = err?.cause?.code || err?.code;

  if (TLS_CODES.has(code)) {
    return new MeshError(
      `TLS trust failure (${code}): something on this network is intercepting HTTPS, and Node does not trust its certificate. ` +
      'Node ignores the system keychain, which is why browsers still work. ' +
      'Capture the chain with:  openssl s_client -showcerts -connect api.meshapi.ai:443 </dev/null | awk \'/BEGIN CERT/,/END CERT/\' > ca.pem  ' +
      'then start the server with NODE_EXTRA_CA_CERTS=./ca.pem (it must be set before Node starts — .env is too late). ' +
      'Be aware that whatever is intercepting can read your API key in transit.',
      502
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new MeshError('DNS lookup failed for the gateway — no network, or a DNS/proxy problem.', 502);
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return new MeshError('Connection to the gateway was refused or reset — check a VPN or firewall.', 502);
  }
  if (err?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new MeshError('The gateway did not respond in time.', 504);
  }

  return new MeshError(err?.message || 'Upstream request failed', 502);
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
    let res;
    try {
      res = await fetch(`${config.mesh.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        signal: t.signal,
        body: JSON.stringify({ model, messages, stream: true })
      });
    } catch (err) {
      /* A caller-initiated stop must stay an AbortError so the UI says
         "Stopped." rather than blaming the network. */
      if (signal?.aborted) throw err;
      throw explainNetworkError(err);
    }
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

    const post = () => fetch(`${config.mesh.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(), signal: t.signal, body: JSON.stringify(body)
    });

    let res;
    try {
      res = await post();
      if (!res.ok && json && (res.status === 400 || res.status === 422)) {
        delete body.response_format;      // model ignores response_format
        res = await post();
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      throw explainNetworkError(err);
    }
    if (!res.ok) throw await toError(res);

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    t.done();
  }
}

/**
 * Mesh returns a BARE ARRAY from /v1/models — not the OpenAI `{ data: [...] }`
 * envelope. Reading `.data` silently produced "0 models visible" while the
 * request itself was fine. Normalise every plausible shape so a future change
 * upstream degrades into a wrong count rather than a wrong diagnosis.
 */
export async function listModels({ signal } = {}) {
  const t = withTimeout(signal);
  try {
    let res;
    try {
      res = await fetch(`${config.mesh.baseUrl}/v1/models`, { headers: headers(), signal: t.signal });
    } catch (err) {
      throw explainNetworkError(err);
    }
    if (!res.ok) throw await toError(res);
    const body = await res.json();
    const rows = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.items) ? body.items
      : Array.isArray(body?.models) ? body.models
      : [];
    return rows;
  } finally {
    t.done();
  }
}

export async function webSearch({ query, maxResults = 12, signal }) {
  const t = withTimeout(signal);
  try {
    let res;
    try {
      res = await fetch(`${config.mesh.baseUrl}/v1/web/search`, {
        method: 'POST',
        headers: headers(),
        signal: t.signal,
        body: JSON.stringify({ query, max_results: maxResults })
      });
    } catch (err) {
      throw explainNetworkError(err);
    }
    if (!res.ok) throw await toError(res);
    const data = await res.json();
    return data.results || [];
  } finally {
    t.done();
  }
}
