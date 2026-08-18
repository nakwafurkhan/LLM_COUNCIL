import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteConversation,
  fetchConfig,
  fetchConversation,
  fetchConversations,
  fetchModels,
  runCodePr,
  streamCouncil,
} from './api';
import {
  CodePrPanel,
  CostPanel,
  FinalAnswer,
  ModelPicker,
  StageOne,
  StageTwo,
} from './components/panels';

const EMPTY_RUN = {
  stage1: [],
  reviews: [],
  leaderboard: [],
  final: '',
  chairman: '',
  degraded: false,
  degradedReason: '',
  sourceModel: '',
  skipped: '',
  totals: null,
  elapsedMs: 0,
  error: '',
  stage: 0,
};

export default function App() {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [modelSource, setModelSource] = useState('');
  const [selected, setSelected] = useState([]);
  const [chairman, setChairman] = useState('');
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [query, setQuery] = useState('');
  const [run, setRun] = useState(EMPTY_RUN);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState('council');
  const [prBusy, setPrBusy] = useState(false);
  const [prResult, setPrResult] = useState(null);
  const [prError, setPrError] = useState('');
  const abortRef = useRef(null);

  /* ---------------- bootstrap ---------------- */
  useEffect(() => {
    (async () => {
      try {
        const cfg = await fetchConfig();
        setConfig(cfg);
        setSelected(cfg.council_models || []);
        setChairman(cfg.chairman_model || '');
      } catch (err) {
        setRun((prev) => ({ ...prev, error: 'Backend unreachable. Is it running?' }));
      }
      try {
        const payload = await fetchModels();
        setModels(payload.models || []);
        setModelSource(payload.source);
      } catch (err) {
        /* picker degrades to the configured line-up */
      }
      refreshConversations();
    })();
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const payload = await fetchConversations();
      setConversations(payload.conversations || []);
    } catch (err) {
      /* sidebar is non-critical */
    }
  }, []);

  /* ---------------- run the council ---------------- */
  const submit = useCallback(async () => {
    if (!query.trim() || running) return;
    setRun({ ...EMPTY_RUN });
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    await streamCouncil(
      {
        query,
        models: selected.length ? selected : undefined,
        chairman: chairman || undefined,
        conversation_id: conversationId || undefined,
      },
      (event) => {
        setRun((prev) => {
          const next = { ...prev };
          switch (event.type) {
            case 'run_start':
              next.stage = 1;
              if (event.conversation_id) setConversationId(event.conversation_id);
              break;
            case 'stage_start':
              next.stage = event.stage;
              break;
            case 'stage1_response':
              next.stage1 = [...prev.stage1, event.response];
              break;
            case 'stage2_review':
              next.reviews = [
                ...prev.reviews,
                {
                  reviewer: event.reviewer,
                  parsed: event.parsed,
                  ranks: event.ranks,
                  notes: event.notes,
                },
              ];
              break;
            case 'stage_skipped':
              if (event.stage === 2) next.skipped = event.reason;
              break;
            case 'stage_complete':
              if (event.stage === 2) next.leaderboard = event.leaderboard || [];
              if (event.stage === 3) {
                next.final = event.final || '';
                next.chairman = event.chairman || '';
                next.degraded = Boolean(event.degraded);
                next.degradedReason = event.degraded_reason || '';
                next.sourceModel = event.source_model || '';
              }
              if (event.totals) next.totals = event.totals;
              break;
            case 'run_complete':
              next.totals = event.totals || prev.totals;
              next.elapsedMs = event.elapsed_ms || 0;
              next.leaderboard = event.leaderboard || prev.leaderboard;
              break;
            case 'error':
              next.error = event.message;
              break;
            default:
              break;
          }
          return next;
        });
      },
      controller.signal,
    );

    setRunning(false);
    abortRef.current = null;
    refreshConversations();
  }, [query, running, selected, chairman, conversationId, refreshConversations]);

  const stop = () => {
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
  };

  /* ---------------- conversations ---------------- */
  const openConversation = async (id) => {
    try {
      const conversation = await fetchConversation(id);
      setConversationId(id);
      setTranscript(conversation.turns || []);
      setRun({ ...EMPTY_RUN });
    } catch (err) {
      /* ignore */
    }
  };

  const newConversation = () => {
    setConversationId(null);
    setTranscript([]);
    setRun({ ...EMPTY_RUN });
    setQuery('');
  };

  const removeConversation = async (id, event) => {
    event.stopPropagation();
    await deleteConversation(id);
    if (id === conversationId) newConversation();
    refreshConversations();
  };

  /* ---------------- code + pr ---------------- */
  const doCodePr = async (body) => {
    setPrBusy(true);
    setPrError('');
    setPrResult(null);
    try {
      const payload = await runCodePr({
        ...body,
        models: selected.length ? selected : undefined,
        chairman: chairman || undefined,
      });
      setPrResult(payload);
    } catch (err) {
      setPrError(err.message);
    } finally {
      setPrBusy(false);
    }
  };

  const toggleModel = (id) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );

  const keyMissing = config && !config.mesh_key_configured;

  const stageLabel = useMemo(() => {
    if (!running) return '';
    return ['', 'asking the council…', 'peer review…', 'chairman synthesising…'][run.stage] || '';
  }, [running, run.stage]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          LLM Council
          <em>Mesh</em>
        </div>

        <button className="btn full" onClick={newConversation}>
          + New conversation
        </button>

        <nav className="modes">
          <button
            className={mode === 'council' ? 'on' : ''}
            onClick={() => setMode('council')}
          >
            Council
          </button>
          <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>
            Code + PR
          </button>
        </nav>

        <ModelPicker
          models={models.length ? models : selected.map((id) => ({ id, context_length: 0 }))}
          selected={selected}
          chairman={chairman}
          onToggle={toggleModel}
          onChairman={setChairman}
          source={modelSource}
        />

        <div className="history">
          <div className="picker-head">
            <strong>History</strong>
          </div>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`hist-row ${conversation.id === conversationId ? 'on' : ''}`}
              onClick={() => openConversation(conversation.id)}
            >
              <span className="hist-title">{conversation.title}</span>
              <span className="muted">{conversation.turns}</span>
              <button
                className="x"
                title="Delete"
                onClick={(event) => removeConversation(conversation.id, event)}
              >
                ×
              </button>
            </div>
          ))}
          {!conversations.length ? <p className="muted small">No saved runs yet.</p> : null}
        </div>

        {config ? (
          <footer className="side-foot">
            <div>
              Mesh key: {config.mesh_key_configured ? '✓ set' : '✗ missing'}
            </div>
            <div>GitHub: {config.github_configured ? '✓ set' : '✗ missing'}</div>
          </footer>
        ) : null}
      </aside>

      <main className="main">
        {keyMissing ? (
          <div className="banner bad">
            <b>MESH_API_KEY is not set.</b> Add it to <code>council-py/.env</code> — get a
            key at{' '}
            <a href="https://meshapi.ai" target="_blank" rel="noopener noreferrer">
              meshapi.ai
            </a>
            , then restart the backend.
          </div>
        ) : null}

        {mode === 'council' ? (
          <>
            <div className="composer">
              <textarea
                className="input area"
                rows={3}
                placeholder="Ask the council your hardest question…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
                }}
              />
              <div className="composer-actions">
                <span className="muted small">
                  {selected.length} members · ⌘/Ctrl+Enter to send
                  {stageLabel ? ` · ${stageLabel}` : ''}
                </span>
                {running ? (
                  <button className="btn ghost" onClick={stop}>
                    Stop
                  </button>
                ) : null}
                <button className="btn" disabled={running || !query.trim()} onClick={submit}>
                  {running ? 'Running…' : 'Convene council'}
                </button>
              </div>
              <CostPanel totals={run.totals} elapsedMs={run.elapsedMs} />
            </div>

            {run.error ? <div className="banner bad">{run.error}</div> : null}

            <FinalAnswer
              final={run.final}
              chairman={run.chairman}
              degraded={run.degraded}
              degradedReason={run.degradedReason}
              sourceModel={run.sourceModel}
            />
            <StageTwo
              reviews={run.reviews}
              leaderboard={run.leaderboard}
              skipped={run.skipped}
            />
            <StageOne responses={run.stage1} running={running} />

            {transcript.length && !run.final ? (
              <section className="card">
                <header className="card-head">
                  <h2>Earlier in this conversation</h2>
                </header>
                {transcript.map((turn, index) => (
                  <div className="turn" key={index}>
                    <p className="turn-q">{turn.query}</p>
                    <p className="muted small">{turn.final?.slice(0, 400)}…</p>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : (
          <CodePrPanel
            onRun={doCodePr}
            busy={prBusy}
            result={prResult}
            error={prError}
            defaultRepo={config?.github_default_repo}
          />
        )}
      </main>
    </div>
  );
}
