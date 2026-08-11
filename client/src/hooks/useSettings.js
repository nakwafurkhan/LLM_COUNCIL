import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export const DEFAULT_SETTINGS = {
  quickModel: 'openai/gpt-4o-mini',
  studyModel: 'openai/gpt-4o',
  humanizeModel: 'anthropic/claude-sonnet-4',
  chairModel: 'openai/gpt-4o',
  seats: [
    'openai/gpt-4o',
    'anthropic/claude-sonnet-4',
    'google/gemini-2.5-pro',
    'meta-llama/llama-3.3-70b-instruct'
  ],
  peerReview: true,
  systemPrompt: 'Answer directly and concisely. State a position; flag real uncertainty rather than hedging everywhere.',
  voiceSample: '',
  contextTurns: 3,
  imageSource: 'openverse',
  theme: 'light'
};

/**
 * Settings live in Mongo so every device shares them. Writes are optimistic and
 * debounced — typing in a model field should not fire a request per keystroke.
 */
export function useSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let alive = true;
    api.getSettings()
      .then((stored) => { if (alive && stored && Object.keys(stored).length) setSettings((s) => ({ ...s, ...stored })); })
      .catch(() => { /* first boot, or API down — defaults are fine */ })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const update = useCallback((patch) => {
    setSettings((current) => {
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { api.saveSettings(next).catch(() => {}); }, 700);
      return next;
    });
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { settings, update, loaded };
}
