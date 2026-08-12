import { marked } from "marked";
import DOMPurify from "dompurify";

function renderSafeMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(content ?? ""), {
    FORBID_TAGS: ["script", "style"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

export default function ChairmanPanel({ run, streamingText, chairmanModel }) {
  const content = run?.finalAnswer ?? streamingText;
  const model = run?.chairmanModel ?? chairmanModel;
  const confidence = run?.confidence;
  const confidenceNote = run?.confidenceNote;
  const partial = run?.partial;
  const partialReason = run?.partialReason;

  if (!content && !streamingText) return null;

  return (
    <section className="chairman-panel" aria-label="Chairman synthesis">
      <header className="chairman-header">
        <h2 className="chairman-title">Chairman Synthesis</h2>
        {model && <span className="chairman-model">{model}</span>}
        {confidence != null && (
          <span className="chairman-confidence">Confidence: {confidence}</span>
        )}
      </header>

      {partial && (
        <div className="chairman-partial-banner" role="alert">
          <strong>Partial result:</strong> {partialReason ?? "Some members did not respond."}
        </div>
      )}

      {confidenceNote && <p className="chairman-confidence-note">{confidenceNote}</p>}

      <div
        aria-live="polite"
        aria-atomic="false"
        className="chairman-body"
        dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content) }}
      />

      {run?.totals && (
        <footer className="chairman-totals">
          <span>
            Total cost: {run.totals.costUsd != null ? `$${run.totals.costUsd.toFixed(4)}` : "—"}
          </span>
          <span>Latency: {run.totals.latencyMs}ms</span>
          <span>
            {run.totals.promptTokens}↑ {run.totals.completionTokens}↓ tokens
          </span>
        </footer>
      )}
    </section>
  );
}
