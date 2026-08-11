import { memo } from 'react';
import { SeatCard, ChairCard, QuickCard, StageLabel } from './cards.jsx';
import { Leaderboard } from './Leaderboard.jsx';
import { StudyPack } from './StudyPack.jsx';
import { HumanizeResult } from './HumanizeResult.jsx';
import { MODES } from '../lib/modes.js';
import { seatColor, timeAgo } from '../lib/markdown.js';

export function UserBubble({ mode, prompt, imageUrl, note }) {
  return (
    <div className="usermsg">
      <div className="bubble">
        <div className="modetag">
          {MODES[mode]?.tag || mode}{note ? ` · ${note}` : ''}
        </div>
        {imageUrl ? <img src={imageUrl} alt="attached" /> : null}
        {prompt || <em>(image only)</em>}
      </div>
    </div>
  );
}

/**
 * A finished run, live or restored — identical either way, because the server
 * persists exactly what the stream produced.
 */
export const Turn = memo(function Turn({ run, restored }) {
  return (
    <section className="turn">
      <UserBubble
        mode={run.mode}
        prompt={run.prompt}
        imageUrl={run.imageUrl}
        note={restored ? `saved ${timeAgo(run.createdAt)}` : ''}
      />

      {run.mode === 'quick' && (
        <QuickCard model={run.models?.[0] || ''} text={run.answer} />
      )}

      {run.mode === 'council' && (
        <>
          <StageLabel n="1">Deliberation</StageLabel>
          <div className="grid">
            {(run.seats || []).map((seat) => (
              <SeatCard
                key={seat.index}
                seat={{ ...seat, done: true }}
                color={seatColor(seat.index)}
                score={run.ranking?.find((r) => r.index === seat.index && r.votes)}
              />
            ))}
          </div>

          {run.ranking?.length > 0 && (
            <>
              <StageLabel n="2">Anonymous peer review</StageLabel>
              <Leaderboard ranking={run.ranking} />
            </>
          )}

          {run.chair?.text && (
            <>
              <StageLabel n="3">Chairman synthesis</StageLabel>
              <ChairCard chair={run.chair} />
            </>
          )}
        </>
      )}

      {run.mode === 'study' && run.study && (
        <>
          <StageLabel>Study pack</StageLabel>
          <StudyPack model={run.models?.[0] || ''} study={run.study} />
        </>
      )}

      {run.mode === 'humanize' && run.humanize && (
        <>
          <StageLabel>Humanized</StageLabel>
          <HumanizeResult
            model={run.models?.[0] || ''}
            humanize={run.humanize}
            original={run.prompt}
          />
        </>
      )}
    </section>
  );
});
