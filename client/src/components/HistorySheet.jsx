import { memo } from 'react';
import { Sheet } from './Sheet.jsx';
import { useRuns } from '../hooks/useRuns.js';
import { MODES } from '../lib/modes.js';
import { timeAgo } from '../lib/markdown.js';

export const HistorySheet = memo(function HistorySheet({ open, onClose, onOpenRun, notify }) {
  const { runs, query, setQuery, loading, error, remove, clear } = useRuns({ enabled: open });

  const wipe = async () => {
    if (!window.confirm('Delete every saved run? This cannot be undone.')) return;
    await clear();
    notify('History cleared');
  };

  return (
    <Sheet open={open} title="History" onClose={onClose}>
      <div className="searchbar">
        <input
          type="search"
          placeholder="Search your saved runs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="storeline">
        Saved to <b>MongoDB</b>. Every run is kept with its full transcript, peer scores and verdict.
      </div>

      {error && <div className="empty check-bad">{error}</div>}

      {!error && !runs.length && (
        <div className="empty">
          {loading ? 'Loading…' : query ? 'Nothing matches that.' : 'No saved runs yet. Ask something and it lands here.'}
        </div>
      )}

      {runs.map((run, i) => (
        <div className="hrow" key={run.id} style={{ animationDelay: `${i * 26}ms` }}>
          <span className="hdot" style={{ background: MODES[run.mode]?.tint || 'var(--accent)' }} />
          <button className="hopen" onClick={() => onOpenRun(run.id)}>
            <span className="htitle">{run.title || run.prompt}</span>
            <span className="hmeta">
              {MODES[run.mode]?.label || run.mode} · {timeAgo(run.createdAt)}
              {run.models?.length > 1 ? ` · ${run.models.length} models` : ''}
            </span>
          </button>
          <button className="hdel" aria-label="Delete" onClick={() => remove(run.id)}>✕</button>
        </div>
      ))}

      {runs.length > 0 && (
        <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
          <button className="btn sm" onClick={wipe}>Delete all history</button>
        </div>
      )}
    </Sheet>
  );
});
