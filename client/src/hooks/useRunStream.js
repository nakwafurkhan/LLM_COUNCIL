import { useCallback, useReducer, useRef } from 'react';
import { streamRun } from '../lib/api.js';

/**
 * Owns the live turn. SSE events are folded into one immutable state object, so
 * every renderer downstream is a pure function of it and history replay can
 * reuse the exact same components by handing them a finished run.
 */
const empty = {
  status: 'idle',        // idle | streaming | done | error | stopped
  mode: 'quick',
  prompt: '',
  imageUrl: '',
  stages: [],
  main: '',
  seats: [],
  ranking: null,
  chair: null,
  error: '',
  run: null
};

function reducer(state, action) {
  switch (action.type) {
    case 'start':
      return { ...empty, status: 'streaming', mode: action.mode, prompt: action.prompt, imageUrl: action.imageUrl };

    case 'stage':
      return { ...state, stages: [...state.stages, action.data] };

    case 'seat': {
      const seats = [...state.seats];
      seats[action.data.index] = {
        index: action.data.index, model: action.data.model,
        text: '', done: false, error: '', ms: 0, firstTokenMs: 0, words: 0
      };
      return { ...state, seats };
    }

    case 'delta': {
      const { target, text } = action.data;
      if (target === 'main') return { ...state, main: state.main + text };
      if (target === 'chair') {
        return { ...state, chair: { ...(state.chair || { model: '' }), text: (state.chair?.text || '') + text } };
      }
      const index = Number(target.split(':')[1]);
      const seats = [...state.seats];
      if (!seats[index]) return state;
      seats[index] = { ...seats[index], text: seats[index].text + text };
      return { ...state, seats };
    }

    case 'seatDone': {
      const seats = [...state.seats];
      const { index, ...rest } = action.data;
      if (!seats[index]) return state;
      seats[index] = { ...seats[index], ...rest, done: true };
      return { ...state, seats };
    }

    case 'review':
      return { ...state, ranking: action.data.ranking };

    case 'done':
      /* The persisted run is authoritative — it carries the server-parsed study
         pack and humanizer sections the stream only sent as raw text. */
      return { ...state, status: 'done', run: action.data.run };

    case 'error':
      return { ...state, status: action.data.message === 'Stopped.' ? 'stopped' : 'error', error: action.data.message };

    case 'reset':
      return empty;

    default:
      return state;
  }
}

export function useRunStream({ onComplete } = {}) {
  const [state, dispatch] = useReducer(reducer, empty);
  const abortRef = useRef(null);

  const start = useCallback(({ mode, prompt, imageUrl, history, settings }) => {
    dispatch({ type: 'start', mode, prompt, imageUrl });

    abortRef.current = streamRun(
      { mode, prompt, imageUrl, history, settings },
      {
        onEvent: (event, data) => {
          dispatch({ type: event, data });
          if (event === 'done') onComplete?.(data.run);
        },
        onError: (err) => dispatch({ type: 'error', data: { message: err.message } }),
        onClose: () => { abortRef.current = null; }
      }
    );
  }, [onComplete]);

  const stop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    dispatch({ type: 'error', data: { message: 'Stopped.' } });
  }, []);

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { live: state, start, stop, reset, isStreaming: state.status === 'streaming' };
}
