import { marked } from "marked";
import DOMPurify from "dompurify";

function renderSafeMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(content ?? ""), {
    FORBID_TAGS: ["script", "style"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

function formatCost(usd) {
  if (usd == null) return null;
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(4)}`;
}

function renderSkeleton() {
  return (
    <div
      className="council-card council-card--loading"
      aria-busy="true"
      aria-label="Loading response"
    >
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton skeleton-line skeleton-line--short" />
      <div className="skeleton skeleton-line" />
    </div>
  );
}

export default function CouncilCard({ answer, loading }) {
  if (loading && !answer) return renderSkeleton();

  const { model, status, content, error, latencyMs, promptTokens, completionTokens, costUsd } =
    answer ?? {};

  const isFulfilled = status === "fulfilled";
  const isError = status === "rejected" || status === "timeout";

  return (
    <article
      className={`council-card council-card--${status ?? "loading"}`}
      aria-label={`Response from ${model}`}
    >
      <header className="council-card-header">
        <span className="council-card-model">{model}</span>
        <span className={`council-card-status council-card-status--${status}`}>{status}</span>
        {costUsd != null && <span className="council-card-cost">{formatCost(costUsd)}</span>}
        {latencyMs != null && <span className="council-card-latency">{latencyMs}ms</span>}
        {promptTokens != null && (
          <span className="council-card-tokens">
            {promptTokens}↑ {completionTokens}↓
          </span>
        )}
      </header>

      {isFulfilled && (
        <div
          className="council-card-body"
          dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content) }}
        />
      )}
      {isError && (
        <div className="council-card-error" role="alert">
          <strong>{status === "timeout" ? "Timed out" : "Failed"}:</strong>{" "}
          {error ?? "An error occurred"}
        </div>
      )}
    </article>
  );
}
