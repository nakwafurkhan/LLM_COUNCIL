import React, { memo, useState } from 'react';
import Markdown from './Markdown';

/**
 * Council stages, rendered inline in the thread as collapsible sections.
 *
 * Stage 1 and 2 are supporting evidence, not the answer, so they sit collapsed
 * above the chairman's response — available when you want to audit the run,
 * out of the way when you don't.
 */

export const StageOne = memo(function StageOne({ responses, running }) {
  const [active, setActive] = useState(0);

  if (!responses.length) {
    return running ? (
      <details className="stage" open>
        <summary>
          <span className="stage-name">First opinions</span>
          <span className="stage-note">asking the council…</span>
        </summary>
        <div className="stage-body">
          <div className="skeleton" style={{ marginTop: 12 }} />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </details>
    ) : null;
  }

  const current = responses[Math.min(active, responses.length - 1)];
  const failed = responses.filter((r) => r.error).length;

  return (
    <details className="stage">
      <summary>
        <span className="stage-name">First opinions</span>
        <span className="stage-note">
          {responses.length - failed} answered{failed ? ` · ${failed} failed` : ''}
        </span>
      </summary>
      <div className="stage-body">
        <div className="tabs" role="tablist">
          {responses.map((response, index) => (
            <button
              type="button"
              key={`${response.model}-${index}`}
              role="tab"
              aria-selected={index === active}
              className={`tab${response.error ? ' failed' : ''}`}
              onClick={() => setActive(index)}
              title={response.model}
            >
              {response.model.split('/').pop()}
            </button>
          ))}
        </div>

        {current.error ? (
          <p className="dim">
            This seat returned no answer ({current.error}). The run continued with
            the remaining members.
          </p>
        ) : (
          <>
            <Markdown>{current.content}</Markdown>
            <div className="meta">
              <span>{current.model}</span>
              {current.total_tokens ? <span>{current.total_tokens} tokens</span> : null}
              {current.latency_ms ? <span>{current.latency_ms} ms</span> : null}
              {current.cached ? <span className="tag">cached</span> : null}
              {current.used_fallback ? <span className="tag">fallback</span> : null}
            </div>
          </>
        )}
      </div>
    </details>
  );
});

export const StageTwo = memo(function StageTwo({ reviews, leaderboard, skipped }) {
  if (skipped) {
    return (
      <details className="stage">
        <summary>
          <span className="stage-name">Peer review</span>
          <span className="stage-note">skipped</span>
        </summary>
        <div className="stage-body">
          <p className="dim" style={{ marginTop: 12 }}>
            {skipped}
          </p>
        </div>
      </details>
    );
  }

  if (!reviews.length) return null;
  const unparsed = reviews.filter((review) => !review.parsed).length;

  return (
    <details className="stage">
      <summary>
        <span className="stage-name">Peer review</span>
        <span className="stage-note">
          authorship hidden · {reviews.length - unparsed}/{reviews.length} counted
        </span>
      </summary>
      <div className="stage-body">
        {leaderboard.length ? (
          <table className="board">
            <thead>
              <tr>
                <th />
                <th>Model</th>
                <th>Points</th>
                <th>Avg rank</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((row) => (
                <tr key={row.label}>
                  <td className="rank">{row.position}</td>
                  <td className="who">{row.model}</td>
                  <td>{row.points}</td>
                  <td>{row.average_rank ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="skeleton" style={{ marginTop: 12 }} />
        )}

        {reviews.map((review, index) => (
          <div className="review" key={`${review.reviewer}-${index}`}>
            <div className="review-who">{review.reviewer} ranked</div>
            {review.parsed ? (
              <ol>
                {Object.entries(review.ranks)
                  .sort((a, b) => a[1] - b[1])
                  .map(([label, rank]) => (
                    <li key={label}>
                      {label}
                      {review.notes?.[label] ? ` — ${review.notes[label]}` : ''}
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="dim" style={{ margin: '4px 0 0' }}>
                Returned no parseable ranking. Excluded from scoring rather than
                counted as zero.
              </p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
});
