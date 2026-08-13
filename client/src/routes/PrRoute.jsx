import { useState, useCallback, useEffect } from "react";
import { usePrJob } from "../hooks/usePrJob.js";
import DiffViewer from "../components/DiffViewer.jsx";
import JobStatus from "../components/JobStatus.jsx";
import ModelPicker from "../components/ModelPicker.jsx";

export default function PrRoute() {
  const { job, loading, error, submitJob, streamJob, approveJob, rejectJob } = usePrJob();

  const [task, setTask] = useState("");
  const [model, setModel] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (!task.trim()) return;
      const jobId = await submitJob({ task: task.trim(), model });
      if (jobId) {
        setSubmitted(true);
        streamJob(jobId);
      }
    },
    [task, model, submitJob, streamJob],
  );

  const handleApprove = useCallback(() => {
    if (job?.id) approveJob(job.id);
  }, [job, approveJob]);

  const handleReject = useCallback(() => {
    if (job?.id) rejectJob(job.id);
  }, [job, rejectJob]);

  const handleReset = useCallback(() => {
    setTask("");
    setSubmitted(false);
  }, []);

  useEffect(() => {
    if (job?.id && job.status && !["completed", "failed", "cancelled"].includes(job.status)) {
      streamJob(job.id);
    }
    // Intentionally run only on mount
  }, []);

  const allDiffs =
    job?.files
      ?.map((f) => f.diff)
      .filter(Boolean)
      .join("\n") ?? "";

  return (
    <div className="pr-route">
      <div className="pr-header">
        <h1 className="pr-title">Code + PR</h1>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <p>Error: {error.message}</p>
        </div>
      )}

      {!submitted ? (
        <form className="pr-form" onSubmit={handleSubmit} aria-label="Submit PR task">
          <div className="pr-form-field">
            <label htmlFor="pr-task" className="pr-label">
              Task description
            </label>
            <textarea
              id="pr-task"
              className="pr-textarea"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what you want the AI to build or change…"
              rows={5}
              required
              aria-label="Task description"
            />
          </div>
          <div className="pr-form-controls">
            <ModelPicker id="pr-model" label="Model" value={model} onChange={setModel} />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={loading || !task.trim()}
              aria-label="Submit task"
            >
              {loading ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      ) : (
        <div className="pr-job">
          <JobStatus job={job} />

          {job?.plan && (
            <section className="pr-plan" aria-label="Implementation plan">
              <h2>Plan</h2>
              <pre className="pr-plan-text">{job.plan}</pre>
            </section>
          )}

          {job?.files?.length > 0 && (
            <section className="pr-files" aria-label="Changed files">
              <h2>Changed Files</h2>
              {job.files.map((f, i) => (
                <details key={i} className="pr-file">
                  <summary className="pr-file-summary">
                    <span className={`pr-file-action pr-file-action--${f.action}`}>
                      {f.action}
                    </span>
                    <span className="pr-file-path">{f.path}</span>
                  </summary>
                  <DiffViewer
                    diff={f.diff}
                    status={job.status}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    loading={loading}
                  />
                </details>
              ))}
            </section>
          )}

          {allDiffs && job?.files?.length === 0 && (
            <DiffViewer
              diff={allDiffs}
              status={job?.status}
              onApprove={handleApprove}
              onReject={handleReject}
              loading={loading}
            />
          )}

          {job?.status === "awaiting_approval" && (
            <div className="pr-approval-actions">
              <button
                className="btn btn--primary"
                onClick={handleApprove}
                disabled={loading}
                aria-label="Approve and push PR"
              >
                Approve &amp; Push
              </button>
              <button
                className="btn btn--danger"
                onClick={handleReject}
                disabled={loading}
                aria-label="Reject changes"
              >
                Reject
              </button>
            </div>
          )}

          {(job?.status === "completed" ||
            job?.status === "failed" ||
            job?.status === "cancelled") && (
            <button
              className="btn btn--secondary"
              onClick={handleReset}
              aria-label="Start new task"
            >
              New task
            </button>
          )}
        </div>
      )}
    </div>
  );
}
