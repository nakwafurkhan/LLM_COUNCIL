import { memo, useState } from 'react';
import { Markdown } from './cards.jsx';
import { countWords } from '../lib/markdown.js';

function Section({ title, open, children }) {
  const [isOpen, setOpen] = useState(Boolean(open));
  return (
    <div className="hsec">
      <button className="hsummary" aria-expanded={isOpen} onClick={() => setOpen((v) => !v)}>
        {title}
      </button>
      {isOpen && <div className="inner">{children}</div>}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text.trim());
    } catch {
      /* clipboard API needs a secure context; fall back to the old trick */
      const ta = document.createElement('textarea');
      ta.value = text.trim();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1900);
  };

  return (
    <button className={`copybtn${copied ? ' done' : ''}`} onClick={copy} type="button">
      <svg viewBox="0 0 24 24">
        <rect x="9" y="9" width="11" height="11" rx="2.5" />
        <path d="M5.5 15H5a1.8 1.8 0 0 1-1.8-1.8V5A1.8 1.8 0 0 1 5 3.2h8.2A1.8 1.8 0 0 1 15 5v.5" />
      </svg>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export const HumanizeResult = memo(function HumanizeResult({ model, humanize, original }) {
  return (
    <article className="human">
      <header>
        <div className="avatar">H</div>
        <div className="cardname">Humanized<span>{model}</span></div>
      </header>

      <div className="finalwrap">
        <Markdown text={humanize.final} className="finaltext" />
      </div>

      <div className="finalbar">
        <CopyButton text={humanize.final} />
        <span className="wordstat">
          {countWords(original)} words in · {countWords(humanize.final)} out
        </span>
      </div>

      {humanize.tells?.length > 0 && (
        <Section title={`What still read as AI in the first draft · ${humanize.tells.length}`} open>
          <ul className="tells">{humanize.tells.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Section>
      )}

      {humanize.changes?.length > 0 && (
        <Section title={`Patterns removed · ${humanize.changes.length}`}>
          <ul className="tells">{humanize.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </Section>
      )}

      {humanize.draft && (
        <Section title="First draft, before the audit">
          <Markdown text={humanize.draft} className="body flat" />
        </Section>
      )}

      <Section title="Your original">
        <div className="pretext">{original}</div>
      </Section>
    </article>
  );
});
