/**
 * API helpers.
 *
 * The council endpoint is a POST that streams server-sent events, so EventSource
 * (GET-only) is no use — we read the response body as a stream and split frames
 * by hand. Partial frames are buffered until the terminating blank line arrives.
 */

export async function fetchConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Could not load config');
  return response.json();
}

export async function fetchModels() {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error('Could not load models');
  return response.json();
}

export async function fetchConversations() {
  const response = await fetch('/api/conversations');
  if (!response.ok) throw new Error('Could not load conversations');
  return response.json();
}

export async function fetchConversation(id) {
  const response = await fetch(`/api/conversations/${id}`);
  if (!response.ok) throw new Error('Could not load conversation');
  return response.json();
}

export async function deleteConversation(id) {
  const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Could not delete conversation');
  return response.json();
}

/**
 * Run the council, invoking `onEvent` for every streamed event.
 * Returns when the stream terminates.
 */
export async function streamCouncil(body, onEvent, signal) {
  const response = await fetch('/api/council', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload.detail) detail = JSON.stringify(payload.detail);
    } catch (err) {
      /* non-JSON error body; keep the status line */
    }
    onEvent({ type: 'error', message: detail });
    return;
  }

  if (!response.body) {
    onEvent({ type: 'error', message: 'Streaming is not supported by this browser.' });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
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
          // A malformed frame should not kill an otherwise good run.
          console.warn('Unparseable SSE frame', payload);
        }
      }
    }
  }
}

export async function runCodePr(body) {
  const response = await fetch('/api/code-pr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof payload.detail === 'string' ? payload.detail : 'Code + PR run failed',
    );
  }
  return payload;
}
