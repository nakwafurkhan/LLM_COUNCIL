import { marked } from "marked";
import DOMPurify from "dompurify";

function formatCost(usd) {
  if (usd == null) return null;
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(4)}`;
}

function renderSafeMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(content ?? ""), {
    FORBID_TAGS: ["script", "style"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

function renderMessage(msg) {
  const { id, role, content, model, promptTokens, completionTokens, costUsd, latencyMs } = msg;
  const isUser = role === "user";
  return (
    <article key={id} className={`message message--${role}`} aria-label={`${role} message`}>
      <div className="message-meta-top">
        <span className="message-role">{isUser ? "You" : (model ?? "Assistant")}</span>
      </div>
      <div
        className="message-body"
        dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content) }}
      />
      {!isUser && (promptTokens != null || costUsd != null) && (
        <div className="message-meta-bottom">
          {promptTokens != null && (
            <span className="meta-tokens">
              {promptTokens}↑ {completionTokens}↓ tokens
            </span>
          )}
          {costUsd != null && <span className="meta-cost">{formatCost(costUsd)}</span>}
          {latencyMs != null && <span className="meta-latency">{latencyMs}ms</span>}
        </div>
      )}
    </article>
  );
}

export default function MessageList({ messages, streamingText }) {
  return (
    <section
      className="message-list"
      aria-label="Conversation messages"
      aria-live="polite"
      aria-atomic="false"
    >
      {messages.map((msg) => renderMessage(msg))}
      {streamingText && (
        <article
          className="message message--assistant message--streaming"
          aria-label="assistant message"
        >
          <div className="message-meta-top">
            <span className="message-role">Assistant</span>
          </div>
          <div
            className="message-body"
            dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(streamingText) }}
          />
        </article>
      )}
    </section>
  );
}
