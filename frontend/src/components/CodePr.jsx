import React, { memo, useState } from 'react';
import Markdown from './Markdown';
import Meta from './Meta';

/**
 * Code + PR mode.
 *
 * Dry run is the default and the button label says so: nothing is pushed until
 * the user explicitly opts in, because the alternative is a surprise commit.
 */
function CodePr({ onRun, busy, result, error, defaultRepo }) {
  const [request, setRequest] = useState('');
  const [repo, setRepo] = useState(defaultRepo || '');
  const [openPr, setOpenPr] = useState(false);

  const submit = (event) => {
    event.preventDefault();
    if (!request.trim() || busy) return;
    const [owner, name] = repo.split('/');
    onRun({
      request: request.trim(),
      owner: owner || undefined,
      repo: name || undefined,
      open_pr: openPr,
    });
  };

  return (
    <div className="thread">
      <form onSubmit={submit}>
        <div className="composer-box" style={{ marginBottom: 10 }}>
          <textarea
            rows={3}
            placeholder="Describe the change — e.g. add retry with backoff to the upload client"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
          />
        </div>
        <div className="composer-foot">
          <input
            className="mini"
            style={{ minWidth: 180 }}
            placeholder="owner/repo"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
          >
            <input
              type="checkbox"
              checked={openPr}
              onChange={(event) => setOpenPr(event.target.checked)}
            />
            Open a real pull request
          </label>
          <span className="spacer" />
          <button
            type="submit"
            className="ghost-btn"
            disabled={busy || !request.trim()}
          >
            {busy ? 'Drafting…' : openPr ? 'Draft & open PR' : 'Draft (dry run)'}
          </button>
        </div>
      </form>

      {!openPr ? (
        <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
          Dry run: the council drafts the patch and nothing is pushed. Review the
          files, then tick the box.
        </p>
      ) : null}

      {busy ? (
        <div className="center-note">
          The council is drafting and reviewing implementations. This takes a minute.
        </div>
      ) : null}

      {error ? (
        <div className="notice hard" style={{ marginTop: 16 }}>
          <div className="notice-title">Could not complete</div>
          {error}
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 22 }}>
          {result.pr ? (
            <div className="notice hard">
              <div className="notice-title">
                Pull request #{result.pr.number} opened
              </div>
              Branch <code>{result.pr.branch}</code> into <code>{result.pr.base}</code>{' '}
              ·{' '}
              <a href={result.pr.url} target="_blank" rel="noopener noreferrer">
                view on GitHub
              </a>
            </div>
          ) : null}

          {result.valid === false ? (
            <div className="notice hard">
              <div className="notice-title">Rejected before touching GitHub</div>
              {result.validation_error}
            </div>
          ) : null}

          {result.summary ? <Markdown>{result.summary}</Markdown> : null}

          {(result.files || []).map((file) => (
            <details className="file" key={file.path}>
              <summary>{file.path}</summary>
              <pre>{file.content}</pre>
            </details>
          ))}

          {result.leaderboard?.length ? (
            <details className="stage" style={{ marginTop: 14 }}>
              <summary>
                <span className="stage-name">Peer review</span>
                <span className="stage-note">
                  {result.leaderboard.length} proposals ranked
                </span>
              </summary>
              <div className="stage-body">
                <table className="board">
                  <thead>
                    <tr>
                      <th />
                      <th>Model</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.leaderboard.map((row) => (
                      <tr key={row.label}>
                        <td className="rank">{row.position}</td>
                        <td className="who">{row.model}</td>
                        <td>{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}

          <Meta totals={result.totals} />
        </div>
      ) : null}
    </div>
  );
}

export default memo(CodePr);
