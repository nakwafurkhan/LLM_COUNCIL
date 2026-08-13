import { useState, useCallback } from "react";
import { useSSE } from "./useSSE.js";

const INITIAL_STATE = {
  run: null,
  status: "idle", // idle | streaming | done | error
  error: null,
  // Three passes
  draftText: "",
  auditNotes: null, // string[] once pass 2 is complete
  auditText: "", // streaming text of audit pass
  finalText: "",
  // Analysis
  before: null,
  model: null,
};

export function useHumanizerRun() {
  const [state, setState] = useState(INITIAL_STATE);
  const { startSSE, abort } = useSSE();

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  const submitText = useCallback(
    (text, { voiceSample, tone, model, stream = true } = {}) => {
      setState({ ...INITIAL_STATE, status: "streaming" });

      const body = {
        text,
        stream,
        ...(voiceSample ? { voiceSample } : {}),
        ...(tone ? { tone } : {}),
        ...(model ? { model } : {}),
      };

      startSSE("/humanize", body, {
        onEvent(event, data) {
          setState((s) => {
            switch (event) {
              case "start":
                return {
                  ...s,
                  before: data.before ?? null,
                  model: data.model ?? null,
                };
              case "draft-delta":
                return { ...s, draftText: s.draftText + (data.text ?? "") };
              case "draft":
                return { ...s, draftText: data.text ?? s.draftText };
              case "audit-delta":
                return { ...s, auditText: s.auditText + (data.text ?? "") };
              case "audit":
                return { ...s, auditNotes: data.notes ?? [] };
              case "final-delta":
                return { ...s, finalText: s.finalText + (data.text ?? "") };
              case "complete":
                return { ...s, run: data };
              case "done":
                return { ...s, status: "done" };
              case "error":
                return {
                  ...s,
                  status: "error",
                  error: new Error(data?.error?.message ?? "Humanizer error"),
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

  return { ...state, submitText, abort, reset };
}
