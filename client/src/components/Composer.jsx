import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MODES, councilCost } from '../lib/modes.js';

export const Composer = memo(function Composer({
  mode, settings, attachment, onDetach, onAttach, onSend, onStop, onClear, isStreaming
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);

  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, []);

  useEffect(grow, [value, grow]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text && !attachment) return;
    onSend(text);
    setValue('');
  }, [value, attachment, onSend]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!isStreaming) submit();
    }
  };

  const cost = mode === 'council'
    ? councilCost(settings.seats.length, settings.peerReview)
    : (mode === 'humanize' && settings.voiceSample ? '1 call · voice-matched' : MODES[mode].cost);

  const canSend = Boolean(value.trim() || attachment);

  return (
    <footer>
      <div className="composer">
        {attachment && (
          <div className="attachrow">
            <div className="attach">
              <img src={attachment.url} alt="" />
              <span className="t">{attachment.title || 'image'}</span>
              <button className="x" aria-label="Remove" onClick={onDetach}>✕</button>
            </div>
          </div>
        )}

        <div className="inputshell">
          <button className="plusbtn" title="Attach an image" aria-label="Attach an image" onClick={onAttach}>
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            placeholder={MODES[mode].placeholder}
            aria-label="Message"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />

          <button
            className={`send${isStreaming ? ' stop' : ''}`}
            aria-label={isStreaming ? 'Stop' : 'Send'}
            disabled={!isStreaming && !canSend}
            onClick={isStreaming ? onStop : submit}
          >
            {isStreaming
              ? <svg viewBox="0 0 24 24"><rect x="7.5" y="7.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none" /></svg>
              : <svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>}
          </button>
        </div>

        <div className="hint">
          <span><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline · <kbd>⌘1/2/3/4</kbd> mode</span>
          <span className="cost">{cost}</span>
          <span className="spacer" />
          <button className="linkbtn" onClick={onClear}>Clear</button>
        </div>
      </div>
    </footer>
  );
});
