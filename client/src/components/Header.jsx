import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MODE_LIST } from '../lib/modes.js';

const ICONS = {
  quick: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />,
  council: (
    <>
      <circle cx="8" cy="9" r="2.4" />
      <circle cx="16" cy="9" r="2.4" />
      <path d="M3.5 19c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4M11.5 19c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4" />
    </>
  ),
  study: (
    <>
      <path d="M4 4.5h6a2.5 2.5 0 0 1 2 2.5 2.5 2.5 0 0 1 2-2.5h6v13h-6a2.5 2.5 0 0 0-2 2 2.5 2.5 0 0 0-2-2H4z" />
      <path d="M12 7v12" />
    </>
  ),
  humanize: (
    <>
      <path d="M4 20.5c1.2-3.4 3.9-5 8-5s6.8 1.6 8 5" />
      <circle cx="12" cy="8" r="4" />
    </>
  )
};

/** macOS segmented control: the knob is one element that slides, measured from
    live rects so it stays exact at any width. */
function ModeSwitch({ mode, onMode }) {
  const wrapRef = useRef(null);
  const [knob, setKnob] = useState({ left: 0, width: 0 });

  const place = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const active = wrap.querySelector('button[aria-pressed="true"]');
    if (!active) return;
    const a = active.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setKnob({ left: a.left - w.left - 2.5, width: a.width });
  }, []);

  useEffect(() => { place(); }, [mode, place]);
  useEffect(() => {
    window.addEventListener('resize', place);
    document.fonts?.ready?.then(place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  return (
    <div className="segmented" ref={wrapRef} data-mode={mode} role="group" aria-label="Answer mode">
      <span className="knob" style={{ transform: `translateX(${knob.left}px)`, width: knob.width }} />
      {MODE_LIST.map((m, i) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          title={`${m.label} (⌘${i + 1})`}
          onClick={() => onMode(m.id)}
        >
          <svg viewBox="0 0 24 24">{ICONS[m.id]}</svg>
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

export const Header = memo(function Header({ mode, onMode, brandSub, onOpen, theme, onToggleTheme }) {
  return (
    <header>
      <div className="brand">
        <div className="seal">LC</div>
        <div>
          <h1>LLM Council</h1>
          <small>{brandSub}</small>
        </div>
      </div>

      <ModeSwitch mode={mode} onMode={onMode} />

      <div className="actions">
        <button className="iconbtn" title="History (⌘H)" aria-label="History" onClick={() => onOpen('history')}>
          <svg viewBox="0 0 24 24">
            <path d="M3.2 12a8.8 8.8 0 1 0 2.6-6.2" />
            <path d="M3 4.5V9h4.5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </button>
        <button className="iconbtn" title="Images (⌘I)" aria-label="Images" onClick={() => onOpen('images')}>
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3.5" width="18" height="17" rx="4" />
            <circle cx="8.6" cy="9" r="1.7" />
            <path d="M21 15.5 16.5 11l-8.5 9" />
          </svg>
        </button>
        <button className="iconbtn" title="Appearance" aria-label="Toggle appearance" onClick={onToggleTheme}>
          {theme === 'dark'
            ? <svg viewBox="0 0 24 24"><path d="M20.4 14.2A8.4 8.4 0 0 1 9.8 3.6a8.4 8.4 0 1 0 10.6 10.6z" /></svg>
            : (
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4" />
              </svg>
            )}
        </button>
        <button className="iconbtn" title="Settings (⌘K)" aria-label="Settings" onClick={() => onOpen('settings')}>
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
});
