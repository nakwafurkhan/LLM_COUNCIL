import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  deleteConversation,
  fetchConfig,
  fetchConversation,
  fetchConversations,
  fetchModels,
  runCodePr,
  streamChat,
  streamCouncil,
} from './api';
import { EMPTY_RUN, createBatcher } from './runState';
import Markdown from './components/Markdown';
import Meta from './components/Meta';
import ModelPicker from './components/ModelPicker';
import Sidebar, { MODES } from './components/Sidebar';
import { StageOne, StageTwo } from './components/Stages';

// Code + PR is a whole second interface; it loads only when selected.
const CodePr = lazy(() => import('./components/CodePr'));


const PLACEHOLDERS = {
  chat: 'Ask anything…',
  quick: 'Ask something short…',
  council: 'Ask the council your hardest question…',
  humanize: 'Paste the text you want to sound human…',
};

const SUGGESTIONS = {
  chat: ['Explain SSE vs WebSockets', 'Review this SQL index strategy'],
  quick: ['Postgres vs MySQL in one line', 'What port does HTTPS use?'],
  council: [
    'Should we shard this database or scale vertically?',
    'Is my retention metric measuring the right thing?',
  ],
  humanize: ['Paste a stiff paragraph and pick a tone'],
};

const STAGE_LABEL = ['', 'asking the council', 'peer review', 'synthesising'];

/** Per-mode model memory, so switching modes does not lose your choice. */
function useStoredModel(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* private mode — non-fatal */
    }
  }, [key, value]);
  return [value, setValue];
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [modelSource, setModelSource] = useState('');
  const [mode, setMode] = useState('chat');
  const [collapsed, setCollapsed] = useState(false);

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [turns, setTurns] = useState([]);

  const [query, setQuery] = useState('');
  const [tone, setTone] = useState('neutral');
  const [length, setLength] = useState('keep');
  const [run, setRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [bootError, setBootError] = useState('');

  const [prBusy, setPrBusy] = useState(false);
  const [prResult, setPrResult] = useState(null);
  const [prError, setPrError] = useState('');

  const [chatModel, setChatModel] = useStoredModel('model.chat', '');
  const [quickModel, setQuickModel] = useStoredModel('model.quick', '');
  const [humanModel, setHumanModel] = useStoredModel('model.humanize', '');
  const [councilModels, setCouncilModels] = useStoredModel('model.council', []);
  const [chairman, setChairman] = useStoredModel('model.chairman', '');

  const abortRef = useRef(null);
  const runRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  /* ------------------------------------------------------------ bootstrap */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchConfig();
        if (cancelled) return;
        setConfig(cfg);
        setChatModel((v) => v || cfg.chat_model);
        setQuickModel((v) => v || cfg.quick_model);
        setHumanModel((v) => v || cfg.humanizer_model);
        setCouncilModels((v) => (v && v.length ? v : cfg.council_models));
        setChairman((v) => v || cfg.chairman_model);
      } catch (err) {
        if (!cancelled) {
          setBootError(
            'Cannot reach the backend. Start it with: python -m uvicorn backend.main:app --port 8000',
          );
        }
      }
      try {
        const payload = await fetchModels();
        if (cancelled) return;
        setModels(payload.models || []);
        setModelSource(payload.source);
      } catch (err) {
        /* picker falls back to configured models */
      }
      refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchConversations();
      setConversations(payload.conversations || []);
    } catch (err) {
      /* sidebar is non-critical */
    }
  }, []);

  /* keep the newest content in view while streaming */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 220;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [run, turns]);

  /* auto-grow the composer */
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [query]);

  /* ------------------------------------------------------------ send */
  const send = useCallback(async () => {
    const text = query.trim();
    if (!text || running) return;

    const isCouncil = mode === 'council';
    const fresh = { ...EMPTY_RUN, mode, pendingQuery: text };
    runRef.current = fresh;
    setRun(fresh);
    setRunning(true);
    setQuery('');

    const controller = new AbortController();
    abortRef.current = controller;
    // Mirror every reduced state into a ref so the post-stream bookkeeping
    // below can read the final state without a setState round-trip.
    const batcher = createBatcher((updater) =>
      setRun((prev) => {
        const next = updater(prev);
        runRef.current = next;
        return next;
      }),
    );

    const body = isCouncil
      ? {
          query: text,
          models: councilModels.length ? councilModels : undefined,
          chairman: chairman || undefined,
          conversation_id: conversationId || undefined,
        }
      : {
          query: text,
          mode,
          model:
            (mode === 'chat' ? chatModel : mode === 'quick' ? quickModel : humanModel) ||
            undefined,
          tone,
          length,
          conversation_id: conversationId || undefined,
        };

    const stream = isCouncil ? streamCouncil : streamChat;

    await stream(
      body,
      (event) => {
        if (event.conversation_id) setConversationId(event.conversation_id);
        batcher.push(event);
      },
      controller.signal,
    );

    batcher.flush();
    setRunning(false);
    abortRef.current = null;

    // Fold the finished run into the transcript so the next turn stacks under it.
    // An errored or aborted run stays put so the user can still read it.
    const finished = runRef.current;
    if (finished && !finished.error && (finished.final || finished.text)) {
      setTurns((prev) => [
        ...prev,
        {
          query: text,
          source: text,
          mode,
          final: isCouncil ? finished.final : finished.text,
          model: finished.model,
          totals: finished.totals,
          stage1: finished.stage1,
          leaderboard: finished.leaderboard,
          skipped: finished.skipped,
          degraded: finished.degraded,
          degradedReason: finished.degradedReason,
          sourceModel: finished.sourceModel,
          elapsedMs: finished.elapsedMs,
          sourceWords: finished.sourceWords,
          resultWords: finished.resultWords,
        },
      ]);
      runRef.current = null;
      setRun(null);
    }

    refresh();
  }, [
    query,
    running,
    mode,
    councilModels,
    chairman,
    chatModel,
    quickModel,
    humanModel,
    tone,
    length,
    conversationId,
    refresh,
  ]);

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  /* ------------------------------------------------------------ history */
  const openConversation = async (id) => {
    try {
      const conversation = await fetchConversation(id);
      setConversationId(id);
      setTurns(
        (conversation.turns || []).map((turn) => ({
          query: turn.query,
          source: turn.query,
          mode: turn.mode || conversation.mode || 'chat',
          final: turn.final,
          model: turn.model,
          totals: turn.totals,
          stage1: turn.stage1 || [],
          leaderboard: turn.leaderboard || [],
        })),
      );
      setRun(null);
      if (conversation.mode && MODES.some((m) => m.id === conversation.mode)) {
        setMode(conversation.mode);
      }
      if (window.innerWidth <= 820) setCollapsed(true);
    } catch (err) {
      /* ignore */
    }
  };

  const startNew = () => {
    setConversationId(null);
    setTurns([]);
    setRun(null);
    setQuery('');
    setPrResult(null);
    setPrError('');
  };

  const removeConversation = async (id) => {
    try {
      await deleteConversation(id);
      if (id === conversationId) startNew();
      refresh();
    } catch (err) {
      /* ignore */
    }
  };

  /* ------------------------------------------------------------ code + pr */
  const doCodePr = async (body) => {
    setPrBusy(true);
    setPrError('');
    setPrResult(null);
    try {
      setPrResult(
        await runCodePr({
          ...body,
          models: councilModels.length ? councilModels : undefined,
          chairman: chairman || undefined,
        }),
      );
    } catch (err) {
      setPrError(err.message);
    } finally {
      setPrBusy(false);
    }
  };

  /* ------------------------------------------------------------ render */
  const modelList = useMemo(() => {
    if (models.length) return models;
    const ids = new Set(
      [chatModel, quickModel, humanModel, chairman, ...councilModels].filter(Boolean),
    );
    return [...ids].map((id) => ({ id, context_length: 0 }));
  }, [models, chatModel, quickModel, humanModel, chairman, councilModels]);

  const keyMissing = config && !config.mesh_key_configured;
  const title = MODES.find((m) => m.id === mode)?.label || 'Chat';
  const showEmpty = !turns.length && !run && !running;

  const renderTurn = (turn, index) => (
    <div key={index}>
      <div className="msg user">
        <div className="msg-role">
          {turn.mode === 'humanize' ? 'Original' : 'You'}
        </div>
        <div className="msg-body">{turn.query}</div>
      </div>

      <div className="msg">
        <div className="msg-role">
          {turn.mode === 'council' ? 'Council' : 'Assistant'}
        </div>

        {turn.mode === 'council' ? (
          <>
            <StageOne responses={turn.stage1 || []} running={false} />
            <StageTwo
              reviews={[]}
              leaderboard={turn.leaderboard || []}
              skipped={turn.skipped}
            />
          </>
        ) : null}

        {turn.degraded ? (
          <div className="notice hard">
            <div className="notice-title">Chairman unavailable</div>
            {turn.degradedReason} Showing the peer-ranked winner from{' '}
            <code>{turn.sourceModel}</code>, unsynthesised.
          </div>
        ) : null}

        {turn.mode === 'humanize' ? (
          <div className="compare">
            <div>
              <h4>Before{turn.sourceWords ? ` · ${turn.sourceWords} words` : ''}</h4>
              <div className="original">{turn.source}</div>
            </div>
            <div>
              <h4>After{turn.resultWords ? ` · ${turn.resultWords} words` : ''}</h4>
              <Markdown>{turn.final}</Markdown>
            </div>
          </div>
        ) : (
          <Markdown>{turn.final}</Markdown>
        )}

        <Meta
          totals={turn.totals}
          elapsedMs={turn.elapsedMs}
          model={turn.mode === 'council' ? undefined : turn.model}
        />
        <div className="msg-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => navigator.clipboard?.writeText(turn.final || '')}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <Sidebar
        mode={mode}
        onMode={(next) => {
          setMode(next);
          setRun(null);
        }}
        conversations={conversations}
        conversationId={conversationId}
        onOpen={openConversation}
        onDelete={removeConversation}
        onNew={startNew}
        onCollapse={() => setCollapsed(true)}
        config={config}
      />

      <main className="main">
        <div className="topbar">
          {collapsed ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setCollapsed(false)}
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              ⇥
            </button>
          ) : null}
          <h1>{title}</h1>
          {running ? (
            <span className="dim" style={{ fontSize: 12 }}>
              {mode === 'council' ? STAGE_LABEL[run?.stage || 1] : 'writing'}…
            </span>
          ) : null}
        </div>

        <div className="scroll" ref={scrollRef}>
          {mode === 'code' ? (
            <Suspense fallback={<div className="center-note">Loading…</div>}>
              <CodePr
                onRun={doCodePr}
                busy={prBusy}
                result={prResult}
                error={prError}
                defaultRepo={config?.github_default_repo}
              />
            </Suspense>
          ) : (
            <div className="thread">
              {bootError ? (
                <div className="notice hard">
                  <div className="notice-title">Backend unreachable</div>
                  {bootError}
                </div>
              ) : null}

              {keyMissing ? (
                <div className="notice hard">
                  <div className="notice-title">MESH_API_KEY is not set</div>
                  Add it to <code>.env</code> in the project root, then restart the
                  backend. Get a key at{' '}
                  <a href="https://meshapi.ai" target="_blank" rel="noopener noreferrer">
                    meshapi.ai
                  </a>
                  .
                </div>
              ) : null}

              {showEmpty ? (
                <div className="empty">
                  <h2>{title}</h2>
                  <p>
                    {mode === 'council'
                      ? 'Several models answer independently, rank each other blind, then a chairman writes the final answer.'
                      : mode === 'humanize'
                        ? 'Paste text that reads like a machine wrote it. Pick a tone and it comes back sounding human.'
                        : mode === 'quick'
                          ? 'Same as Chat, but a cheap model and a hard length limit. For when you want an answer, not an essay.'
                          : 'A straight conversation with one model of your choosing.'}
                  </p>
                  <div className="suggestions">
                    {(SUGGESTIONS[mode] || []).map((text) => (
                      <button
                        type="button"
                        className="suggestion"
                        key={text}
                        onClick={() => setQuery(text)}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {turns.map(renderTurn)}

              {run ? (
                <div>
                  <div className="msg user">
                    <div className="msg-role">
                      {mode === 'humanize' ? 'Original' : 'You'}
                    </div>
                    <div className="msg-body">{run.pendingQuery}</div>
                  </div>

                  <div className="msg">
                    <div className="msg-role">
                      {mode === 'council' ? 'Council' : 'Assistant'}
                    </div>

                    {mode === 'council' ? (
                      <>
                        <StageOne responses={run.stage1} running={running} />
                        <StageTwo
                          reviews={run.reviews}
                          leaderboard={run.leaderboard}
                          skipped={run.skipped}
                        />
                      </>
                    ) : null}

                    {run.error ? (
                      <div className="notice hard">
                        <div className="notice-title">
                          {run.error.kind === 'credit'
                            ? 'Mesh balance empty'
                            : run.error.kind === 'auth'
                              ? 'Mesh rejected the key'
                              : 'Something went wrong'}
                        </div>
                        {run.error.message}
                      </div>
                    ) : null}

                    <div className={running ? 'caret' : undefined}>
                      <Markdown>
                        {mode === 'council' ? run.final : run.text}
                      </Markdown>
                    </div>

                    <Meta totals={run.totals} elapsedMs={run.elapsedMs} />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {mode !== 'code' ? (
          <div className="composer-wrap">
            <div className="composer">
              <div className="composer-box">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder={PLACEHOLDERS[mode]}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                {running ? (
                  <button
                    type="button"
                    className="send"
                    onClick={stop}
                    title="Stop"
                    aria-label="Stop"
                  >
                    ■
                  </button>
                ) : (
                  <button
                    type="button"
                    className="send"
                    onClick={send}
                    disabled={!query.trim()}
                    title="Send"
                    aria-label="Send"
                  >
                    ↑
                  </button>
                )}
              </div>

              <div className="composer-foot">
                <div className="controls">
                  {mode === 'council' ? (
                    <>
                      <ModelPicker
                        models={modelList}
                        selected={councilModels}
                        onChange={setCouncilModels}
                        multi
                        label="Council"
                      />
                      <ModelPicker
                        models={modelList}
                        selected={chairman}
                        onChange={setChairman}
                        label="Chairman"
                      />
                    </>
                  ) : (
                    <ModelPicker
                      models={modelList}
                      selected={
                        mode === 'chat'
                          ? chatModel
                          : mode === 'quick'
                            ? quickModel
                            : humanModel
                      }
                      onChange={
                        mode === 'chat'
                          ? setChatModel
                          : mode === 'quick'
                            ? setQuickModel
                            : setHumanModel
                      }
                    />
                  )}

                  {mode === 'humanize' ? (
                    <>
                      <select
                        className="mini"
                        value={tone}
                        onChange={(event) => setTone(event.target.value)}
                        aria-label="Tone"
                      >
                        <option value="neutral">Neutral</option>
                        <option value="plain">Plain</option>
                        <option value="warm">Warm</option>
                        <option value="direct">Direct</option>
                      </select>
                      <select
                        className="mini"
                        value={length}
                        onChange={(event) => setLength(event.target.value)}
                        aria-label="Length"
                      >
                        <option value="tighten">Tighten</option>
                        <option value="keep">Keep length</option>
                        <option value="expand">Expand</option>
                      </select>
                    </>
                  ) : null}
                </div>

                <span className="spacer" />
                <span>
                  {mode === 'council'
                    ? `${councilModels.length} members · ~${councilModels.length * 2 + 1} calls`
                    : 'Enter to send · Shift+Enter for a new line'}
                </span>
                {modelSource === 'config' ? <span className="tag">offline list</span> : null}
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
