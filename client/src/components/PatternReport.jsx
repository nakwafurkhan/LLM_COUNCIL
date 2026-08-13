/**
 * PatternReport — renders an Analysis object from the humanizer API.
 *
 * Scope caveat: this report covers only mechanically detectable patterns
 * (em dashes, curly quotes, AI vocabulary, etc.). It does NOT assess
 * judgement-level qualities such as voice, originality, or significance.
 * A score of zero does not mean the text is perfect.
 */

const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" };

function severityClass(severity) {
  if (severity === "high") return "pattern-finding--high";
  if (severity === "medium") return "pattern-finding--medium";
  return "pattern-finding--low";
}

export default function PatternReport({ analysis, label }) {
  if (!analysis) return null;

  const { total, wordCount, per1000Words, findings } = analysis;

  return (
    <section className="pattern-report" aria-label={label ?? "Pattern analysis"}>
      <header className="pattern-report-header">
        <h3 className="pattern-report-title">{label ?? "Pattern analysis"}</h3>
        <div className="pattern-report-summary">
          <span className="pattern-report-total" aria-label={`${total} total pattern hits`}>
            {total} pattern{total !== 1 ? "s" : ""}
          </span>
          {wordCount > 0 && (
            <span className="pattern-report-rate">
              {per1000Words != null ? per1000Words.toFixed(1) : "—"} per 1 000 words
            </span>
          )}
        </div>
        <p className="pattern-report-caveat" role="note">
          This score counts only mechanically detectable signals — things like em dashes, curly
          quotes, hedge phrases, and AI vocabulary lists. It does not assess voice, originality,
          or judgement-level qualities. A zero does not guarantee the text reads as
          human-written or is high quality.
        </p>
      </header>

      {total === 0 && (
        <p className="pattern-report-clean">
          No mechanical patterns detected. See the caveat above — this does not guarantee the
          text reads as human-written.
        </p>
      )}

      {findings && findings.length > 0 && (
        <ul className="pattern-findings" aria-label="Findings">
          {findings.map((f) => (
            <li key={f.id} className={`pattern-finding ${severityClass(f.severity)}`}>
              <div className="pattern-finding-header">
                <span className="pattern-finding-label">{f.label}</span>
                <span
                  className={`pattern-finding-severity pattern-finding-severity--${f.severity}`}
                  aria-label={`Severity: ${SEVERITY_LABEL[f.severity] ?? f.severity}`}
                >
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
                </span>
                <span className="pattern-finding-count" aria-label={`${f.count} occurrences`}>
                  {f.count}×
                </span>
              </div>
              {f.note && <p className="pattern-finding-note">{f.note}</p>}
              {f.examples && f.examples.length > 0 && (
                <ul className="pattern-finding-examples" aria-label="Examples">
                  {f.examples.map((ex, i) => (
                    <li key={i} className="pattern-finding-example">
                      &ldquo;{ex}&rdquo;
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
