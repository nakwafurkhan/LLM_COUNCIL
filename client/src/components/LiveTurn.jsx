import { memo } from 'react';
import { SeatCard, ChairCard, QuickCard, StageLabel, Markdown, Skeleton } from './cards.jsx';
import { Leaderboard } from './Leaderboard.jsx';
import { UserBubble } from './Turn.jsx';
import { seatColor } from '../lib/markdown.js';

/**
 * The in-flight turn. Renders raw streaming text; once the server sends `done`,
 * App moves the persisted run into the finished list and this unmounts — which
 * is why study packs and humanizer output only need their raw form here.
 */
export const LiveTurn = memo(function LiveTurn({ live }) {
  const { mode, prompt, imageUrl, seats, ranking, chair, main, stages, status, error } = live;
  const deliberation = stages.find((s) => s.stage === 'deliberation');
  const seatsIn = seats.filter((s) => s?.done).length;

  return (
    <section className="turn">
      <UserBubble mode={mode} prompt={prompt} imageUrl={imageUrl} />

      {mode === 'quick' && <QuickCard model="" text={main} />}

      {mode === 'council' && (
        <>
          <StageLabel n="1" live={deliberation ? `${seatsIn}/${deliberation.total} in` : ''}>
            Deliberation
          </StageLabel>
          <div className="grid">
            {seats.map((seat) => seat && (
              <SeatCard
                key={seat.index}
                seat={seat}
                color={seatColor(seat.index)}
                score={ranking?.find((r) => r.index === seat.index && r.votes)}
              />
            ))}
          </div>

          {stages.some((s) => s.stage === 'review') && (
            <>
              <StageLabel n="2">Anonymous peer review</StageLabel>
              {ranking ? <Leaderboard ranking={ranking} /> : <div className="board"><Skeleton /></div>}
            </>
          )}

          {chair && (
            <>
              <StageLabel n="3">Chairman synthesis</StageLabel>
              <ChairCard chair={chair} />
            </>
          )}
        </>
      )}

      {(mode === 'study' || mode === 'humanize') && (
        <>
          <StageLabel>{stages[0]?.label || 'Working'}</StageLabel>
          <article className={mode === 'study' ? 'pack' : 'human'}>
            <header>
              <div className="avatar">{mode === 'study' ? '✦' : 'H'}</div>
              <div className="cardname">{mode === 'study' ? 'Study pack' : 'Humanized'}<span>streaming…</span></div>
            </header>
            {main
              ? <Markdown text={main.replace(/^##\s*(DRAFT|TELLS|FINAL|CHANGES)\s*$/gim, '')} />
              : <Skeleton />}
          </article>
        </>
      )}

      {(status === 'error' || status === 'stopped') && (
        <div className={`runerror${status === 'stopped' ? ' muted' : ''}`}>{error}</div>
      )}
    </section>
  );
});
