/**
 * Streaming run state.
 *
 * A fast token stream can fire hundreds of events per second. Calling setState
 * on each one thrashes React and drops frames, so events are reduced into a
 * plain object and flushed at most once per animation frame.
 */

export const EMPTY_RUN = {
  mode: 'chat',
  pendingQuery: '',
  model: '',
  // single-model modes
  text: '',
  sourceWords: null,
  resultWords: null,
  // council
  stage: 0,
  stage1: [],
  reviews: [],
  leaderboard: [],
  final: '',
  chairman: '',
  degraded: false,
  degradedReason: '',
  sourceModel: '',
  skipped: '',
  // shared
  totals: null,
  elapsedMs: 0,
  error: null,
  done: false,
};

export function reduceEvent(state, event) {
  switch (event.type) {
    case 'run_start':
      return {
        ...state,
        mode: event.mode || state.mode,
        model: event.model || state.model,
        sourceWords: event.source_words ?? null,
        stage: 1,
      };

    // ---- single-model modes ----
    case 'delta':
      return { ...state, text: state.text + event.text };

    // ---- council ----
    case 'stage_start':
      return { ...state, stage: event.stage };

    case 'stage1_response':
      return { ...state, stage1: [...state.stage1, event.response] };

    case 'stage2_review':
      return {
        ...state,
        reviews: [
          ...state.reviews,
          {
            reviewer: event.reviewer,
            parsed: event.parsed,
            ranks: event.ranks || {},
            notes: event.notes || {},
          },
        ],
      };

    case 'stage_skipped':
      return event.stage === 2 ? { ...state, skipped: event.reason } : state;

    case 'stage3_delta':
      return { ...state, final: state.final + event.text };

    case 'stage_complete': {
      const next = { ...state };
      if (event.stage === 2) next.leaderboard = event.leaderboard || [];
      if (event.stage === 3) {
        // A degraded stage 3 replaces any streamed text with the fallback answer.
        next.final = event.final || state.final;
        next.chairman = event.chairman || '';
        next.degraded = Boolean(event.degraded);
        next.degradedReason = event.degraded_reason || '';
        next.sourceModel = event.source_model || '';
      }
      if (event.totals) next.totals = event.totals;
      return next;
    }

    case 'run_complete':
      return {
        ...state,
        // Single-model runs carry their answer here; council runs already have it.
        text: event.final != null && event.mode ? event.final : state.text,
        final: event.mode ? state.final : state.final,
        model: event.model || state.model,
        totals: event.totals || state.totals,
        elapsedMs: event.elapsed_ms || 0,
        leaderboard: event.leaderboard || state.leaderboard,
        sourceWords: event.source_words ?? state.sourceWords,
        resultWords: event.result_words ?? state.resultWords,
        done: true,
      };

    case 'error':
      return {
        ...state,
        error: { message: event.message, kind: event.kind || 'error' },
        text: event.partial || state.text,
        done: true,
      };

    default:
      return state;
  }
}

/**
 * Collect events off the wire and flush to React once per frame.
 * Returns { push, flush, cancel }.
 */
export function createBatcher(apply) {
  let pending = [];
  let frame = null;

  const flush = () => {
    frame = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    apply((state) => batch.reduce(reduceEvent, state));
  };

  return {
    push(event) {
      pending.push(event);
      // Terminal events flush immediately so the UI never lags a frame behind
      // the final answer.
      if (event.type === 'run_complete' || event.type === 'error') {
        if (frame !== null) cancelAnimationFrame(frame);
        flush();
        return;
      }
      if (frame === null) {
        frame =
          typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(flush)
            : setTimeout(flush, 16);
      }
    },
    flush,
    cancel() {
      if (frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
      frame = null;
      pending = [];
    },
  };
}
