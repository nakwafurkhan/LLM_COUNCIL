/**
 * Server-sent events for a run.
 *
 * The client opens ONE stream per run and receives typed events, instead of the
 * browser firing N streaming fetches and orchestrating the pipeline itself.
 *
 * Event vocabulary:
 *   stage    { stage, label, total? }   a pipeline phase started
 *   seat     { index, model }           a council card should appear
 *   delta    { target, text }           token(s) for 'main' | 'chair' | 'seat:N'
 *   seatDone { index, ms, firstTokenMs, words, error? }
 *   review   { ranking }                peer scores aggregated
 *   done     { run }                    persisted run document
 *   error    { message }
 */
export function createStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /* nginx and friends buffer SSE into uselessness without this */
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  let open = true;

  /* Proxies drop idle connections; a comment line every 15s keeps them honest
     and costs nothing (clients ignore comments). */
  const keepAlive = setInterval(() => { if (open) res.write(': ping\n\n'); }, 15000);

  const send = (event, data) => {
    if (!open) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(keepAlive);
    res.end();
  };

  return { send, close, isOpen: () => open };
}

/**
 * Coalesce tokens per target and flush on a timer. A fast model can emit
 * hundreds of one-character deltas a second; one SSE frame each is pure
 * overhead for both ends. ~50ms is below the threshold where streaming stops
 * feeling live.
 */
export function createBatcher(send, intervalMs = 50) {
  const pending = new Map();
  let timer = null;

  const flush = () => {
    for (const [target, text] of pending) {
      if (text) send('delta', { target, text });
    }
    pending.clear();
    timer = null;
  };

  return {
    push(target, text) {
      pending.set(target, (pending.get(target) || '') + text);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    }
  };
}
