import { memo, useState } from 'react';
import { shortModel, seatColor } from '../lib/markdown.js';

function Row({ entry, max }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="brow" style={{ '--seatcolor': seatColor(entry.index) }}>
        <span className="rank">{entry.rank === 1 ? '★' : entry.rank}</span>
        <span className="who">{shortModel(entry.model)}</span>
        <span className="bar">
          <i style={{ width: `${max ? (entry.mean / max) * 100 : 0}%` }} />
        </span>
        <span className="num">{entry.votes ? `${entry.mean.toFixed(1)}/10` : '—'}</span>
        <button
          className="peek"
          aria-expanded={open}
          aria-label="Show critiques"
          onClick={() => setOpen((v) => !v)}
        >
          ⌄
        </button>
      </div>
      {open && (
        <div className="critiques">
          {entry.critiques.length
            ? entry.critiques.map((c, i) => <div key={i}>{c}</div>)
            : <div>No written critique returned.</div>}
        </div>
      )}
    </>
  );
}

export const Leaderboard = memo(function Leaderboard({ ranking }) {
  if (!ranking?.length || !ranking.some((r) => r.votes)) {
    return (
      <div className="board">
        <div className="boardnote">
          Peer review returned no usable scores — the chair weighed the answers unaided.
        </div>
      </div>
    );
  }
  const max = Math.max(...ranking.map((r) => r.mean), 1);
  return (
    <div className="board">
      {ranking.map((entry) => <Row key={entry.index} entry={entry} max={max} />)}
      <div className="boardnote">
        Scores are means of the other seats only — self-votes are discarded.
      </div>
    </div>
  );
});
