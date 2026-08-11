import { memo, useState } from 'react';
import { Markdown } from './cards.jsx';

function Flashcards({ cards }) {
  const [flipped, setFlipped] = useState(() => new Set());
  const toggle = (i) => setFlipped((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  return (
    <div className="flashwrap">
      {cards.map((card, i) => (
        <button
          key={i}
          className="flash"
          aria-pressed={flipped.has(i)}
          style={{ animationDelay: `${i * 45}ms` }}
          onClick={() => toggle(i)}
        >
          <span className="in">
            <span className="f">{card.q}</span>
            <span className="b">{card.a}</span>
          </span>
        </button>
      ))}
      <div className="flashhint">Tap a card to flip it.</div>
    </div>
  );
}

function Quiz({ items }) {
  const [shown, setShown] = useState(() => new Set());
  const toggle = (i) => setShown((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  return (
    <div className="quiz">
      {items.map((item, i) => (
        <div className="qitem" key={i}>
          <div className="q">{i + 1}. {item.q}</div>
          <button className="reveal" onClick={() => toggle(i)}>
            {shown.has(i) ? 'Hide answer' : 'Show answer'}
          </button>
          {shown.has(i) && <div className="a">{item.a || '—'}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * The pack arrives already parsed from the server, so this is a pure render —
 * live and restored runs go through exactly the same path.
 */
export const StudyPack = memo(function StudyPack({ model, study }) {
  const panes = [];
  const overview = [
    study.orient && `## Orientation\n${study.orient}`,
    study.map && `## Concept map\n${study.map}`
  ].filter(Boolean).join('\n\n');
  const traps = [
    study.misconceptions && `## Misconceptions\n${study.misconceptions}`,
    study.example && `## Worked example\n${study.example}`
  ].filter(Boolean).join('\n\n');

  if (overview) panes.push({ key: 'overview', label: 'Overview', node: <Markdown text={overview} className="body flat" /> });
  if (study.core) panes.push({ key: 'core', label: 'Explanation', node: <Markdown text={study.core} className="body flat" /> });
  if (traps) panes.push({ key: 'traps', label: 'Traps & example', node: <Markdown text={traps} className="body flat" /> });
  if (study.flashcards?.length) panes.push({ key: 'cards', label: `Flashcards · ${study.flashcards.length}`, node: <Flashcards cards={study.flashcards} /> });
  if (study.quiz?.length) panes.push({ key: 'quiz', label: `Quiz · ${study.quiz.length}`, node: <Quiz items={study.quiz} /> });
  if (study.goDeeper) panes.push({ key: 'more', label: 'Go deeper', node: <Markdown text={study.goDeeper} className="body flat" /> });

  const [active, setActive] = useState(0);

  /* Model ignored the format — show what it did say rather than nothing. */
  if (panes.length < 2) {
    return (
      <article className="pack">
        <header>
          <div className="avatar">✦</div>
          <div className="cardname">Study pack<span>{model}</span></div>
        </header>
        <Markdown text={study.raw || ''} />
      </article>
    );
  }

  return (
    <article className="pack">
      <header>
        <div className="avatar">✦</div>
        <div className="cardname">Study pack<span>{model}</span></div>
      </header>
      <div className="packtabs" role="tablist">
        {panes.map((pane, i) => (
          <button
            key={pane.key}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
          >
            {pane.label}
          </button>
        ))}
      </div>
      <div className="packpane">{panes[active].node}</div>
    </article>
  );
});
