import { useCallback } from "react";

/**
 * Parse a unified diff string into hunks of lines with types.
 */
function parseDiff(diff) {
  if (!diff) return [];
  const lines = diff.split("\n");
  const result = [];
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      result.push({ type: "header", text: line });
    } else if (line.startsWith("@@")) {
      result.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      result.push({ type: "addition", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      result.push({ type: "deletion", text: line.slice(1) });
    } else {
      result.push({ type: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return result;
}

export default function DiffViewer({ diff, status, onApprove, onReject, loading }) {
  const canApprove = status === "awaiting_approval";
  const lines = parseDiff(diff);

  const handleApprove = useCallback(() => {
    if (canApprove && onApprove) onApprove();
  }, [canApprove, onApprove]);

  const handleReject = useCallback(() => {
    if (onReject) onReject();
  }, [onReject]);

  return (
    <div className="diff-viewer">
      {diff ? (
        <pre className="diff-pre" aria-label="Diff output">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`diff-line diff-line--${line.type}`}
              aria-label={
                line.type === "addition"
                  ? "addition"
                  : line.type === "deletion"
                    ? "deletion"
                    : undefined
              }
            >
              {line.type === "addition" && <span className="diff-sign diff-sign--add">+</span>}
              {line.type === "deletion" && <span className="diff-sign diff-sign--del">-</span>}
              {line.type !== "addition" && line.type !== "deletion" && (
                <span className="diff-sign"> </span>
              )}
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </pre>
      ) : (
        <p className="diff-empty">No diff available.</p>
      )}

      <div className="diff-actions">
        <button
          className="diff-btn diff-btn--approve"
          onClick={handleApprove}
          disabled={!canApprove || loading}
          aria-label="Approve and push"
          title={canApprove ? "Approve and push PR" : `Cannot approve: status is ${status}`}
        >
          Approve &amp; Push
        </button>
        <button
          className="diff-btn diff-btn--reject"
          onClick={handleReject}
          disabled={loading}
          aria-label="Reject changes"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
