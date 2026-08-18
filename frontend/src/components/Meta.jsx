import React, { memo } from 'react';

/** The quiet one-line cost/latency readout under an answer. */
function Meta({ totals, elapsedMs, model, extra }) {
  if (!totals && !model && !extra) return null;
  const cost = totals?.cost_usd;
  return (
    <div className="meta">
      {model ? <span title="Model">{model}</span> : null}
      {totals?.total_tokens ? (
        <span>
          <strong>{totals.total_tokens.toLocaleString()}</strong> tokens
        </span>
      ) : null}
      {typeof cost === 'number' && cost > 0 ? (
        <span>
          <strong>${cost.toFixed(4)}</strong>
        </span>
      ) : null}
      {totals?.calls > 1 ? <span>{totals.calls} calls</span> : null}
      {elapsedMs ? <span>{(elapsedMs / 1000).toFixed(1)}s</span> : null}
      {totals?.cached_hits ? <span className="tag">cached</span> : null}
      {totals?.fallbacks ? <span className="tag">fallback</span> : null}
      {totals?.failed_calls ? (
        <span className="tag loud">{totals.failed_calls} failed</span>
      ) : null}
      {extra}
    </div>
  );
}

export default memo(Meta);
