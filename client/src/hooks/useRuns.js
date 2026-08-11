import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/** History list. Kept deliberately dumb: fetch, filter, delete, refresh. */
export function useRuns({ enabled }) {
  const [runs, setRuns] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (q = query) => {
    setLoading(true);
    setError('');
    try {
      setRuns(await api.listRuns({ q: q.trim() || undefined }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setTimeout(() => { refresh(query); }, query ? 220 : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query]);

  const remove = useCallback(async (id) => {
    setRuns((rows) => rows.filter((r) => r.id !== id));
    await api.deleteRun(id).catch(() => refresh());
  }, [refresh]);

  const clear = useCallback(async () => {
    setRuns([]);
    await api.clearRuns().catch(() => refresh());
  }, [refresh]);

  return { runs, query, setQuery, loading, error, refresh, remove, clear };
}
