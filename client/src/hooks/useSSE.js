import { useCallback, useRef } from "react";
import { ssePost } from "../api/client.js";

/**
 * Returns a `startSSE(path, body, callbacks)` function that manages abort
 * on unmount automatically.
 */
export function useSSE() {
  const abortRef = useRef(null);

  const startSSE = useCallback((path, body, callbacks) => {
    // Cancel any in-flight request first
    if (abortRef.current) abortRef.current();
    abortRef.current = ssePost(path, body, callbacks);
  }, []);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
  }, []);

  return { startSSE, abort };
}
