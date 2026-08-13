import { useState, useCallback, useRef } from "react";
import { apiFetch } from "../api/client.js";
import { ssePost } from "../api/client.js";

export function usePrJob() {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const submitJob = useCallback(
    async ({ task, targetPaths, branch, baseBranch, model } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const body = {
          task,
          ...(targetPaths?.length ? { targetPaths } : {}),
          ...(branch ? { branch } : {}),
          ...(baseBranch ? { baseBranch } : {}),
          ...(model ? { model } : {}),
        };
        const data = await apiFetch("/pr", { method: "POST", body });
        setJob({ id: data.jobId, status: "queued" });
        return data.jobId;
      } catch (err) {
        setError(err);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const pollJob = useCallback(async (jobId) => {
    const data = await apiFetch(`/pr/${jobId}`);
    setJob(data);
    return data;
  }, []);

  const streamJob = useCallback(
    (jobId) => {
      if (abortRef.current) abortRef.current();
      abortRef.current = ssePost(
        `/pr/${jobId}/stream`,
        {},
        {
          onEvent(event, data) {
            if (event === "status") {
              setJob((prev) => ({ ...(prev ?? {}), id: jobId, ...data }));
            }
          },
          onError(err) {
            setError(err);
          },
          onDone() {
            pollJob(jobId).catch((err) => setError(err));
          },
        },
      );
    },
    [pollJob],
  );

  const approveJob = useCallback(
    async (jobId) => {
      setLoading(true);
      try {
        await apiFetch(`/pr/${jobId}/approve`, { method: "POST", body: {} });
        await pollJob(jobId);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [pollJob],
  );

  const rejectJob = useCallback(async (jobId) => {
    setLoading(true);
    try {
      await apiFetch(`/pr/${jobId}/reject`, { method: "POST", body: {} });
      setJob((prev) => ({ ...(prev ?? {}), status: "cancelled" }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
  }, []);

  return { job, loading, error, submitJob, pollJob, streamJob, approveJob, rejectJob, abort };
}
