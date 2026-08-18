import React, { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const md = (text) => (
  <div className="md">
    <Markdown remarkPlugins={[remarkGfm]}>{text || ''}</Markdown>
  </div>
);

/* ------------------------------------------------------------------ */
/* Stage 1 — tab view over each member's independent answer            */
/* ------------------------------------------------------------------ */
export function StageOne({ responses, running }) {
  const [active, setActive] = useState(0);
  if (!responses.length) {
    return running ? <div className="placeholder">Council is thinking…</div> : null;
  }
  const current = responses[Math.min(active, responses.length - 1)];

  return (
    <section className="card">
      <header className="card-head">
        <h2>Stage 1 · First opinions</h2>
        <span className="muted">{responses.length} member(s) answered independently</span>
      </header>

      <div className="tabs">
        {responses.map((response, index) => (
          <button
            key={`${response.model}-${index}`}
            className={`tab ${index === active ? 'on' : ''} ${response.error ? 'bad' : ''}`}
            onClick={() => setActive(index)}
            title={response.model}
          >
            {response.model.split('/').pop()}
            {response.error ? ' ⚠' : ''}
            {response.used_fallback ? ' ↩' : ''}
          </button>
        ))}
      </div>

      <div className="tab-body">
        <div className="row-meta">
          <code>{current.model}</code>
          {current.error ? (
            <span className="badge bad">failed: {current.error}</span>
          ) : (
            <>
              <span className="badge">{current.total_tokens} tokens</span>
              <span className="badge">{current.latency_ms} ms</span>
              {current.cached ? <span className="badge good">cached</span> : null}
              {current.used_fallback ? <span className="badge warn">fallback used</span> : null}
            </>
          )}
        </div>
        {current.error ? (
          <p className="muted">
            This seat produced no answer. The run continues with the remaining members.
          </p>
        ) : (
          md(current.content)
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 2 — anonymised peer review and the aggregated leaderboard     */
/* ------------------------------------------------------------------ */
export function StageTwo({ reviews, leaderboard, skipped }) {
  if (skipped) {
    return (
      <section className="card">
        <header className="card-head">
          <h2>Stage 2 · Peer review</h2>
          <span className="muted">Skipped — {skipped}</span>
        </header>
      </section>
    );
  }
  if (!reviews.length) return null;

  const unparsed = reviews.filter((review) => !review.parsed).length;

  return (
    <section className="card">
      <header className="card-head">
        <h2>Stage 2 · Peer review</h2>
        <span className="muted">
          Authorship hidden while judging · {reviews.length - unparsed}/{reviews.length}{' '}
          reviews parsed
        </span>
      </header>

      {leaderboard.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Model (revealed after judging)</th>
              <th>Label</th>
              <th>Points</th>
              <th>Avg rank</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map((row) => (
              <tr key={row.label}>
                <td>{row.position}</td>
                <td>
                  <code>{row.model}</code>
                </td>
                <td className="muted">{row.label}</td>
                <td>{row.points}</td>
                <td>{row.average_rank ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="placeholder">Collecting rankings…</div>
      )}

      <details className="details">
        <summary>Individual reviews ({reviews.length})</summary>
        {reviews.map((review, index) => (
          <div className="review" key={`${review.reviewer}-${index}`}>
            <code>{review.reviewer}</code>
            {review.parsed ? (
              <ul>
                {Object.entries(review.ranks)
                  .sort((a, b) => a[1] - b[1])
                  .map(([label, rank]) => (
                    <li key={label}>
                      <b>#{rank}</b> {label}
                      {review.notes?.[label] ? ` — ${review.notes[label]}` : ''}
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="muted">Returned no parseable ranking; excluded from scoring.</p>
            )}
          </div>
        ))}
      </details>
      {unparsed > 0 ? (
        <p className="note">
          {unparsed} reviewer(s) did not return valid JSON. Their votes were excluded
          rather than guessed.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 3 — the chairman's synthesis                                  */
/* ------------------------------------------------------------------ */
export function FinalAnswer({ final, chairman, degraded, degradedReason, sourceModel }) {
  if (!final) return null;
  return (
    <section className="card final">
      <header className="card-head">
        <h2>Stage 3 · Final answer</h2>
        <span className="muted">
          {degraded ? (
            <>Chairman unavailable — showing the peer-ranked winner</>
          ) : (
            <>
              Synthesised by <code>{chairman}</code>
            </>
          )}
        </span>
      </header>
      {degraded ? (
        <div className="banner warn">
          The chairman call failed ({degradedReason || 'unknown error'}). This is the
          highest-ranked member answer from <code>{sourceModel}</code>, unsynthesised.
        </div>
      ) : null}
      {md(final)}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Running cost / latency readout                                      */
/* ------------------------------------------------------------------ */
export function CostPanel({ totals, elapsedMs }) {
  if (!totals || !totals.calls) return null;
  return (
    <div className="cost">
      <span>
        <b>{totals.calls}</b> calls
      </span>
      <span>
        <b>{totals.total_tokens?.toLocaleString?.() ?? totals.total_tokens}</b> tokens
      </span>
      <span>
        <b>${(totals.cost_usd ?? 0).toFixed(4)}</b>
      </span>
      {elapsedMs ? (
        <span>
          <b>{(elapsedMs / 1000).toFixed(1)}s</b>
        </span>
      ) : null}
      {totals.cached_hits ? <span className="good">{totals.cached_hits} cached</span> : null}
      {totals.fallbacks ? <span className="warn">{totals.fallbacks} fallback</span> : null}
      {totals.failed_calls ? <span className="bad">{totals.failed_calls} failed</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Model picker, driven by the live Mesh catalogue                      */
/* ------------------------------------------------------------------ */
export function ModelPicker({ models, selected, chairman, onToggle, onChairman, source }) {
  const [filter, setFilter] = useState('');
  const visible = models.filter((model) =>
    model.id.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="picker">
      <div className="picker-head">
        <strong>Council</strong>
        <span className="muted">
          {selected.length} selected · catalogue: {source || 'loading'}
        </span>
      </div>
      <input
        className="input"
        placeholder="Filter models…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="model-list">
        {visible.slice(0, 120).map((model) => (
          <label key={model.id} className="model-row">
            <input
              type="checkbox"
              checked={selected.includes(model.id)}
              onChange={() => onToggle(model.id)}
            />
            <code>{model.id}</code>
            {model.context_length ? (
              <span className="muted">{Math.round(model.context_length / 1000)}k</span>
            ) : null}
          </label>
        ))}
        {!visible.length ? <p className="muted">No models match.</p> : null}
      </div>

      <label className="chairman-select">
        <span>Chairman</span>
        <select value={chairman} onChange={(event) => onChairman(event.target.value)}>
          {[...new Set([chairman, ...selected, ...models.map((m) => m.id)])]
            .filter(Boolean)
            .slice(0, 200)
            .map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Code + PR mode                                                      */
/* ------------------------------------------------------------------ */
export function CodePrPanel({ onRun, busy, result, error, defaultRepo }) {
  const [request, setRequest] = useState('');
  const [repo, setRepo] = useState(defaultRepo || '');
  const [openPr, setOpenPr] = useState(false);

  const submit = () => {
    const [owner, name] = repo.split('/');
    onRun({
      request,
      owner: owner || undefined,
      repo: name || undefined,
      open_pr: openPr,
    });
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>Code + PR mode</h2>
        <span className="muted">
          The council drafts the change; the chairman merges it into one patch
        </span>
      </header>

      <textarea
        className="input area"
        rows={4}
        placeholder="Describe the change, e.g. 'add retry with backoff to the upload client'"
        value={request}
        onChange={(event) => setRequest(event.target.value)}
      />
      <div className="pr-controls">
        <input
          className="input"
          placeholder="owner/repo"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={openPr}
            onChange={(event) => setOpenPr(event.target.checked)}
          />
          Open a real PR
        </label>
        <button className="btn" disabled={busy || !request.trim()} onClick={submit}>
          {busy ? 'Drafting…' : openPr ? 'Draft & open PR' : 'Draft (dry run)'}
        </button>
      </div>
      {!openPr ? (
        <p className="note">
          Dry run: nothing is pushed. Review the files below, then tick “Open a real PR”.
        </p>
      ) : null}

      {error ? <div className="banner bad">{error}</div> : null}

      {result ? (
        <div className="pr-result">
          {result.pr ? (
            <div className="banner good">
              PR #{result.pr.number} opened on branch <code>{result.pr.branch}</code> →{' '}
              <a href={result.pr.url} target="_blank" rel="noopener noreferrer">
                {result.pr.url}
              </a>
            </div>
          ) : null}
          {result.valid === false ? (
            <div className="banner bad">Rejected: {result.validation_error}</div>
          ) : null}
          {result.summary ? md(result.summary) : null}
          {(result.files || []).map((file) => (
            <details key={file.path} className="details">
              <summary>
                <code>{file.path}</code>
              </summary>
              <pre className="code">{file.content}</pre>
            </details>
          ))}
          <CostPanel totals={result.totals} />
        </div>
      ) : null}
    </section>
  );
}
