import { useState, useCallback } from "react";
import { apiFetch } from "../api/client.js";
import { useSSE } from "./useSSE.js";

const INITIAL_STATE = {
  run: null,
  models: [],
  chairmanModel: null,
  memberAnswers: [],
  chairmanText: "",
  status: "idle", // idle | streaming | done | error
  error: null,
};

export function useCouncilRun() {
  const [state, setState] = useState(INITIAL_STATE);
  const { startSSE, abort } = useSSE();

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  const submitPrompt = useCallback(
    (prompt, { models, chairmanModel, bypassCache, stream = true } = {}) => {
      setState({ ...INITIAL_STATE, status: "streaming" });

      const body = {
        prompt,
        stream,
        ...(models?.length ? { models } : {}),
        ...(chairmanModel ? { chairmanModel } : {}),
        ...(bypassCache != null ? { bypassCache } : {}),
      };

      if (!stream) {
        apiFetch("/council", { method: "POST", body })
          .then((run) => setState((s) => ({ ...s, run, status: "done" })))
          .catch((err) => setState((s) => ({ ...s, error: err, status: "error" })));
        return;
      }

      startSSE("/council", body, {
        onEvent(event, data) {
          setState((s) => {
            switch (event) {
              case "start":
                return {
                  ...s,
                  models: data.models ?? [],
                  chairmanModel: data.chairmanModel ?? null,
                };
              case "member":
                return {
                  ...s,
                  memberAnswers: [...s.memberAnswers, data.answer],
                };
              case "chairman-start":
                return { ...s, chairmanModel: data.model ?? s.chairmanModel };
              case "chairman-delta":
                return { ...s, chairmanText: s.chairmanText + (data.text ?? "") };
              case "complete":
                return { ...s, run: data };
              case "done":
                return { ...s, status: "done" };
              case "error":
                return {
                  ...s,
                  status: "error",
                  error: new Error(data?.error?.message ?? "Council error"),
                };
              default:
                return s;
            }
          });
        },
        onError(err) {
          setState((s) => ({ ...s, status: "error", error: err }));
        },
        onDone() {
          setState((s) => (s.status === "streaming" ? { ...s, status: "done" } : s));
        },
      });
    },
    [startSSE],
  );

  return { ...state, submitPrompt, abort, reset };
}
