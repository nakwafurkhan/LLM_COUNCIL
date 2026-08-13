import { useState, useCallback, useRef } from "react";
import { useHumanizerRun } from "../hooks/useHumanizerRun.js";
import PassPanel from "../components/PassPanel.jsx";
import PatternReport from "../components/PatternReport.jsx";

const TONE_OPTIONS = [
  { value: "", label: "Default" },
  { value: "neutral", label: "Neutral" },
  { value: "casual", label: "Casual" },
  { value: "professional", label: "Professional" },
  { value: "technical", label: "Technical" },
];

export default function HumanizerRoute() {
  const {
    run,
    status,
    error,
    draftText,
    auditNotes,
    auditText,
    finalText,
    before,
    submitText,
    abort,
    reset,
  } = useHumanizerRun();

  const [inputText, setInputText] = useState("");
  const [voiceSample, setVoiceSample] = useState("");
  const [showVoice, setShowVoice] = useState(false);
  const [tone, setTone] = useState("");
  const [copied, setCopied] = useState(false);
  const finalRef = useRef(null);

  const isStreaming = status === "streaming";
  const isDone = status === "done";
  const isError = status === "error";

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const trimmed = inputText.trim();
      if (!trimmed || isStreaming) return;
      submitText(trimmed, {
        ...(voiceSample.trim() ? { voiceSample: voiceSample.trim() } : {}),
        ...(tone ? { tone } : {}),
      });
    },
    [inputText, voiceSample, tone, isStreaming, submitText],
  );

  const handleCopy = useCallback(() => {
    const text = run?.final ?? finalText;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [run, finalText]);

  // Determine display values — prefer run DTO once complete, else streaming state
  const displayDraft = run?.draft ?? draftText;
  const displayAuditNotes = run?.audit?.notes ?? auditNotes;
  const displayFinal = run?.final ?? finalText;
  const displayBefore = run?.before ?? before;
  const displayAfter = run?.after ?? null;
  const diff = run?.diff ?? null;

  return (
    <div className="humanizer-route">
      <div className="humanizer-header">
        <h1 className="humanizer-title">Humanizer</h1>
        <p className="humanizer-subtitle">
          Strips AI-writing tells in three passes — draft, audit, and final rewrite.
        </p>
        {(isDone || isError) && (
          <button className="btn btn--secondary" onClick={reset} aria-label="New humanizer run">
            New run
          </button>
        )}
        {isStreaming && (
          <button className="btn btn--secondary" onClick={abort} aria-label="Stop generation">
            Stop
          </button>
        )}
      </div>

      {isError && error && (
        <div className="error-banner" role="alert">
          <p>Error: {error.message}</p>
          <button className="btn btn--retry" onClick={reset}>
            Try again
          </button>
        </div>
      )}

      <form className="humanizer-form" onSubmit={handleSubmit} aria-label="Humanizer input">
        <div className="humanizer-form-field">
          <label htmlFor="humanizer-input" className="humanizer-label">
            Text to humanize
          </label>
          <textarea
            id="humanizer-input"
            className="humanizer-textarea"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isStreaming}
            placeholder="Paste AI-generated text here (up to 50 000 characters)…"
            rows={8}
            maxLength={50000}
            aria-required="true"
            aria-describedby="humanizer-char-count"
          />
          <span id="humanizer-char-count" className="humanizer-char-count">
            {inputText.length} / 50 000
          </span>
        </div>

        <div className="humanizer-form-row">
          <div className="humanizer-form-field humanizer-form-field--inline">
            <label htmlFor="humanizer-tone" className="humanizer-label">
              Tone
            </label>
            <select
              id="humanizer-tone"
              className="humanizer-select"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              disabled={isStreaming}
            >
              {TONE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn"
            onClick={() => setShowVoice((v) => !v)}
            aria-expanded={showVoice}
            aria-controls="voice-sample-section"
          >
            {showVoice ? "Hide" : "Add"} voice sample
          </button>
        </div>

        {showVoice && (
          <div id="voice-sample-section" className="humanizer-form-field">
            <label htmlFor="humanizer-voice" className="humanizer-label">
              Voice sample{" "}
              <span className="humanizer-label-hint">
                (optional — your own writing for matching)
              </span>
            </label>
            <textarea
              id="humanizer-voice"
              className="humanizer-textarea humanizer-textarea--small"
              value={voiceSample}
              onChange={(e) => setVoiceSample(e.target.value)}
              disabled={isStreaming}
              placeholder="Paste a few paragraphs of your own writing…"
              rows={4}
            />
          </div>
        )}

        <div className="humanizer-form-controls">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={isStreaming || !inputText.trim()}
            aria-busy={isStreaming}
          >
            {isStreaming ? "Humanizing…" : "Humanize"}
          </button>
        </div>
      </form>

      {/* ── Three passes ── */}
      {(draftText || run?.draft) && (
        <div className="humanizer-passes">
          <PassPanel
            heading="Pass 1 — Draft rewrite"
            text={displayDraft}
            streaming={isStreaming && !run?.draft}
            defaultOpen={false}
          />

          <PassPanel
            heading="Pass 2 — Audit (AI tells still present)"
            text={auditText && !displayAuditNotes ? auditText : ""}
            notes={displayAuditNotes ?? undefined}
            streaming={isStreaming && !displayAuditNotes}
            defaultOpen={true}
            prominent={true}
          />

          <PassPanel
            heading="Pass 3 — Final humanized text"
            text={displayFinal}
            streaming={isStreaming && !run?.final}
            defaultOpen={true}
          />

          {displayFinal && (
            <div className="humanizer-copy-row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleCopy}
                ref={finalRef}
                aria-label="Copy final text to clipboard"
              >
                {copied ? "Copied!" : "Copy final text"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Before analysis ── */}
      {displayBefore && (
        <div className="humanizer-reports">
          <PatternReport analysis={displayBefore} label="Before — pattern analysis" />

          {displayAfter && (
            <PatternReport analysis={displayAfter} label="After — pattern analysis" />
          )}

          {/* ── Diff summary ── */}
          {diff && (
            <section className="humanizer-diff-summary" aria-label="Rewrite summary">
              <h3 className="humanizer-diff-title">Rewrite summary</h3>
              <div className="humanizer-diff-scores">
                <div className="humanizer-diff-score">
                  <span className="humanizer-diff-score-label">Before</span>
                  <span className="humanizer-diff-score-value">{diff.before}</span>
                </div>
                <div className="humanizer-diff-arrow" aria-hidden="true">
                  →
                </div>
                <div className="humanizer-diff-score">
                  <span className="humanizer-diff-score-label">After</span>
                  <span
                    className={`humanizer-diff-score-value ${diff.delta < 0 ? "humanizer-diff-score--improved" : diff.delta > 0 ? "humanizer-diff-score--worse" : ""}`}
                  >
                    {diff.after}
                  </span>
                </div>
                <div className="humanizer-diff-score">
                  <span className="humanizer-diff-score-label">Delta</span>
                  <span
                    className={`humanizer-diff-score-value ${diff.delta < 0 ? "humanizer-diff-score--improved" : diff.delta > 0 ? "humanizer-diff-score--worse" : ""}`}
                  >
                    {diff.delta > 0 ? `+${diff.delta}` : diff.delta}
                  </span>
                </div>
              </div>

              {diff.introduced && diff.introduced.length > 0 && (
                <div className="humanizer-regression" role="alert">
                  <strong>Regression — rewrite introduced new tells:</strong>
                  <ul className="humanizer-regression-list">
                    {diff.introduced.map((item) => (
                      <li key={item.id}>
                        {item.label} (+{item.count})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {diff.removed && diff.removed.length > 0 && (
                <div className="humanizer-removed">
                  <strong>Patterns removed:</strong>
                  <ul className="humanizer-removed-list">
                    {diff.removed.map((item) => (
                      <li key={item.id}>
                        {item.label} (−{item.count})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* ── Usage footer ── */}
      {run?.usage && (
        <footer className="humanizer-footer">
          <span>
            Cost: {run.usage.costUsd != null ? `$${run.usage.costUsd.toFixed(4)}` : "—"}
          </span>
          <span>Latency: {run.latencyMs}ms</span>
          <span>
            {run.usage.promptTokens}↑ {run.usage.completionTokens}↓ tokens
          </span>
          {run.model && <span>Model: {run.model}</span>}
        </footer>
      )}
    </div>
  );
}
