/**
 * HTTP + SSE client.
 *
 * Both streaming endpoints are POSTs, so EventSource (GET-only) is no use — we
 * read the response body as a stream and split frames ourselves, buffering any
 * partial frame until its terminating blank line arrives.
 */

async function json(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      typeof payload.detail === 'string' ? payload.detail : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

export const fetchConfig = () => json('/api/config');
export const fetchModels = () => json('/api/models');
export const fetchConversations = () => json('/api/conversations');
export const fetchConversation = (id) => json(`/api/conversations/${id}`);
export const deleteConversation = (id) =>
  json(`/api/conversations/${id}`, { method: 'DELETE' });
export const runCodePr = (body) =>
  json('/api/code-pr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * POST `body` to `path` and invoke `onEvent` for each streamed event.
 * Resolves when the stream ends. Aborting via `signal` is not an error.
 */
export async function streamPost(path, body, onEvent, signal) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    onEvent({
      type: 'error',
      kind: 'network',
      message: 'Could not reach the server. Is the backend running on :8000?',
    });
    return;
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload.detail) detail = String(payload.detail);
    } catch (err) {
      /* keep the status line */
    }
    onEvent({ type: 'error', kind: 'http', message: detail });
    return;
  }

  if (!response.body) {
    onEvent({
      type: 'error',
      kind: 'unsupported',
      message: 'This browser cannot read streamed responses.',
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') return;
          try {
            onEvent(JSON.parse(payload));
          } catch (err) {
            // One malformed frame should not kill an otherwise good run.
            console.warn('Skipping unparseable SSE frame', payload);
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      onEvent({
        type: 'error',
        kind: 'network',
        message: `Stream interrupted: ${err.message}`,
      });
    }
  }
}

export const streamChat = (body, onEvent, signal) =>
  streamPost('/api/chat', body, onEvent, signal);

export const streamCouncil = (body, onEvent, signal) =>
  streamPost('/api/council', body, onEvent, signal);
