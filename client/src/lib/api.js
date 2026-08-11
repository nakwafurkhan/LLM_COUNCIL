/**
 * The only module that knows about HTTP. Everything is same-origin: in dev Vite
 * proxies /api to the server, in production Express serves this bundle.
 */

async function json(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  health: () => json('/health'),
  meshCheck: () => json('/health/mesh'),

  listRuns: ({ q, mode, limit = 60 } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (q) params.set('q', q);
    if (mode) params.set('mode', mode);
    return json(`/runs?${params}`).then(r => r.runs || []);
  },
  getRun: (id) => json(`/runs/${id}`),
  deleteRun: (id) => json(`/runs/${id}`, { method: 'DELETE' }),
  clearRuns: () => json('/runs', { method: 'DELETE' }),

  getSettings: () => json('/settings'),
  saveSettings: (value) => json('/settings', { method: 'PUT', body: JSON.stringify(value) }),

  searchImages: ({ q, source }) =>
    json(`/images?q=${encodeURIComponent(q)}&source=${source || 'openverse'}`).then(r => r.results || [])
};

/**
 * POST a run and consume the SSE response.
 *
 * EventSource cannot POST, so this reads the body stream and parses frames by
 * hand. Returns an abort function; calling it also tells the server to stop,
 * which cancels the upstream model calls.
 */
export function streamRun(body, handlers) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `${res.status} ${res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        /* Frames are separated by a blank line. Keep the trailing partial. */
        const frames = buffer.split('\n\n');
        buffer = frames.pop();

        for (const frame of frames) {
          let event = 'message';
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            /* lines starting with ':' are keep-alive comments */
          }
          if (!dataLines.length) continue;
          try {
            handlers.onEvent?.(event, JSON.parse(dataLines.join('\n')));
          } catch { /* malformed frame — skip rather than kill the stream */ }
        }
      }
      handlers.onClose?.();
    } catch (err) {
      if (err.name === 'AbortError') handlers.onClose?.();
      else handlers.onError?.(err);
    }
  })();

  return () => controller.abort();
}
