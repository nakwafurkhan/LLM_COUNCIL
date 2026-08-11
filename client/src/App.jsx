import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header.jsx';
import { Hero } from './components/Hero.jsx';
import { Composer } from './components/Composer.jsx';
import { Turn } from './components/Turn.jsx';
import { LiveTurn } from './components/LiveTurn.jsx';
import { SettingsSheet } from './components/SettingsSheet.jsx';
import { HistorySheet } from './components/HistorySheet.jsx';
import { ImageSheet } from './components/ImageSheet.jsx';
import { Toast } from './components/Toast.jsx';
import { useRunStream } from './hooks/useRunStream.js';
import { useSettings } from './hooks/useSettings.js';
import { useTheme } from './hooks/useTheme.js';
import { api } from './lib/api.js';
import { MODES } from './lib/modes.js';

export default function App() {
  const { settings, update } = useSettings();
  const [mode, setMode] = useState(() => localStorage.getItem('council-mode') || 'quick');
  const [sheet, setSheet] = useState(null);          // 'settings' | 'history' | 'images'
  const [turns, setTurns] = useState([]);            // finished runs, newest last
  const [attachment, setAttachment] = useState(null);
  const [toast, setToast] = useState('');
  const scrollerRef = useRef(null);
  const stickRef = useRef(true);

  useTheme(settings.theme);

  const notify = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2500);
  }, []);

  const { live, start, stop, reset, isStreaming } = useRunStream({
    onComplete: (run) => {
      setTurns((rows) => [...rows, run]);
      reset();
    }
  });

  useEffect(() => { localStorage.setItem('council-mode', mode); }, [mode]);

  /* Follow the stream unless the reader has scrolled up to read something. */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [live, turns]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 110;
  }, []);

  const send = useCallback((text) => {
    if (isStreaming) return;
    stickRef.current = true;

    /* Only the last few turns travel back as context, and only as plain text. */
    const history = turns.slice(-3).flatMap((run) => [
      { role: 'user', content: run.prompt },
      { role: 'assistant', content: (run.answer || run.chair?.text || run.humanize?.final || run.study?.raw || '').slice(0, 6000) }
    ]).filter((m) => m.content);

    start({
      mode,
      prompt: text,
      imageUrl: attachment?.url || '',
      history,
      settings
    });
    setAttachment(null);
  }, [isStreaming, mode, attachment, settings, turns, start]);

  const openRun = useCallback(async (id) => {
    try {
      const run = await api.getRun(id);
      setTurns((rows) => [...rows, run]);
      setSheet(null);
      stickRef.current = true;
      notify('Restored from history');
    } catch (err) {
      notify(err.message);
    }
  }, [notify]);

  const clearSession = useCallback(() => {
    stop();
    setTurns([]);
    reset();
    setAttachment(null);
    notify('Cleared');
  }, [stop, reset, notify]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') setSheet(null);
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const byIndex = { 1: 'quick', 2: 'council', 3: 'study', 4: 'humanize' }[key];
      if (byIndex) { e.preventDefault(); setMode(byIndex); }
      if (key === 'k') { e.preventDefault(); setSheet('settings'); }
      if (key === 'h') { e.preventDefault(); setSheet('history'); }
      if (key === 'i') { e.preventDefault(); setSheet('images'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isEmpty = turns.length === 0 && live.status === 'idle';

  return (
    <div className="app" data-run={mode}>
      <Header
        mode={mode}
        onMode={setMode}
        brandSub={MODES[mode].brandSub}
        onOpen={setSheet}
        theme={settings.theme}
        onToggleTheme={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
      />

      <main>
        <div className="stream" ref={scrollerRef} onScroll={onScroll}>
          <div className="wrap">
            {isEmpty
              ? <Hero mode={mode} onPick={send} />
              : (
                <>
                  {turns.map((run) => <Turn key={run.id} run={run} />)}
                  {live.status !== 'idle' && <LiveTurn live={live} />}
                </>
              )}
          </div>
        </div>
      </main>

      <Composer
        mode={mode}
        settings={settings}
        attachment={attachment}
        onDetach={() => setAttachment(null)}
        onAttach={() => setSheet('images')}
        onSend={send}
        onStop={stop}
        onClear={clearSession}
        isStreaming={isStreaming}
      />

      <div className={`scrim${sheet ? ' on' : ''}`} onClick={() => setSheet(null)} />

      <SettingsSheet
        open={sheet === 'settings'}
        onClose={() => setSheet(null)}
        settings={settings}
        update={update}
        notify={notify}
      />
      <HistorySheet
        open={sheet === 'history'}
        onClose={() => setSheet(null)}
        onOpenRun={openRun}
        notify={notify}
      />
      <ImageSheet
        open={sheet === 'images'}
        onClose={() => setSheet(null)}
        source={settings.imageSource}
        onPick={(image) => { setAttachment(image); setSheet(null); notify('Image attached'); }}
      />

      <Toast message={toast} />
    </div>
  );
}
