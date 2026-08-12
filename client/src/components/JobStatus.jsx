const STATUS_LABELS = {
  queued: "Queued",
  planning: "Planning…",
  generating: "Generating…",
  verifying: "Verifying…",
  awaiting_approval: "Awaiting approval",
  pushing: "Pushing…",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASSES = {
  queued: "status--pending",
  planning: "status--active",
  generating: "status--active",
  verifying: "status--active",
  awaiting_approval: "status--waiting",
  pushing: "status--active",
  completed: "status--success",
  failed: "status--error",
  cancelled: "status--cancelled",
};

const ALL_STATUSES = [
  "queued",
  "planning",
  "generating",
  "verifying",
  "awaiting_approval",
  "pushing",
  "completed",
];

export default function JobStatus({ job }) {
  if (!job) return null;
  const { status, error, prUrl, prNumber, timeline } = job;
  const label = STATUS_LABELS[status] ?? status;
  const cls = STATUS_CLASSES[status] ?? "";

  return (
    <div className="job-status" aria-label="Job status">
      <div className={`job-status-badge ${cls}`} role="status" aria-live="polite">
        {label}
      </div>

      {status === "failed" && error && (
        <div className="job-status-error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      {prUrl && (
        <a
          href={prUrl}
          className="job-pr-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open PR #${prNumber}`}
        >
          View PR {prNumber ? `#${prNumber}` : ""}
        </a>
      )}

      <ol className="job-timeline" aria-label="Job timeline">
        {ALL_STATUSES.map((s) => {
          const entry = timeline?.find((t) => t.status === s);
          const isCurrent = s === status;
          const isPast =
            ALL_STATUSES.indexOf(s) < ALL_STATUSES.indexOf(status) ||
            status === "completed" ||
            status === "failed";
          return (
            <li
              key={s}
              className={`job-timeline-step ${isCurrent ? "step--current" : ""} ${isPast ? "step--past" : ""}`}
              aria-current={isCurrent ? "step" : undefined}
            >
              <span className="step-label">{STATUS_LABELS[s] ?? s}</span>
              {entry?.at && (
                <time className="step-time" dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString()}
                </time>
              )}
              {entry?.note && <span className="step-note">{entry.note}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
