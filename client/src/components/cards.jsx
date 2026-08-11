import { memo } from 'react';
import { renderMarkdown, shortModel, initials, countWords } from '../lib/markdown.js';

/* One place that turns model text into DOM. The input is escaped inside
   renderMarkdown, so nothing a model emits can inject markup. */
export const Markdown = memo(function Markdown({ text, className = 'body' }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text || '') }} />;
});

export function Skeleton() {
  return (
    <div className="body">
      <div className="skeleton" style={{ width: '94%' }} />
      <div className="skeleton" style={{ width: '80%' }} />
      <div className="skeleton" style={{ width: '56%' }} />
    </div>
  );
}

export function StageLabel({ n, children, live }) {
  return (
    <div className="stagelabel">
      {n ? <span className="n">{n}</span> : null}
      <span>{children}</span>
      {live ? <span className="live">{live}</span> : null}
    </div>
  );
}

function meta(seat) {
  if (seat.error) return 'failed';
  if (!seat.done) return seat.firstTokenMs ? `${seat.firstTokenMs}ms` : '…';
  const words = seat.words || countWords(seat.text);
  return `${seat.firstTokenMs ? `${seat.firstTokenMs}ms · ` : ''}${seat.ms}ms · ${words}w`;
}

/**
 * Memoised on the fields that actually change. Without this, one streaming seat
 * re-renders every card in the grid on every frame.
 */
export const SeatCard = memo(function SeatCard({ seat, color, score }) {
  const failed = Boolean(seat.error);
  return (
    <article className={`card${failed ? ' err' : ''}`} style={{ '--seatcolor': color }}>
      <header>
        <div className="avatar">{initials(seat.model)}</div>
        <div className="cardname">
          {shortModel(seat.model)}
          <span>{seat.model}</span>
        </div>
        {score ? (
          <span className={`scorechip${score.rank === 1 ? ' top' : ''}`}>
            {score.rank === 1 ? '★ ' : `#${score.rank} `}{score.mean.toFixed(1)}
          </span>
        ) : null}
        <div className="meta">{meta(seat)}</div>
      </header>

      {failed
        ? <div className="body"><strong>{seat.error}</strong></div>
        : seat.text
          ? <Markdown text={seat.text} />
          : <Skeleton />}
    </article>
  );
}, (a, b) =>
  a.seat.text === b.seat.text &&
  a.seat.done === b.seat.done &&
  a.seat.error === b.seat.error &&
  a.color === b.color &&
  a.score?.rank === b.score?.rank &&
  a.score?.mean === b.score?.mean
);

export const ChairCard = memo(function ChairCard({ chair }) {
  return (
    <article className="verdict">
      <header>
        <div className="avatar">★</div>
        <div className="cardname">
          Chair
          <span>{chair.model}</span>
        </div>
      </header>
      {chair.text ? <Markdown text={chair.text} /> : <Skeleton />}
    </article>
  );
});

export const QuickCard = memo(function QuickCard({ model, text }) {
  return (
    <article className="card" style={{ '--seatcolor': 'var(--accent)' }}>
      <header>
        <div className="avatar">{initials(model)}</div>
        <div className="cardname">
          {shortModel(model)}
          <span>{model}</span>
        </div>
        <div className="meta">{text ? `${countWords(text)}w` : '…'}</div>
      </header>
      {text ? <Markdown text={text} /> : <Skeleton />}
    </article>
  );
});
