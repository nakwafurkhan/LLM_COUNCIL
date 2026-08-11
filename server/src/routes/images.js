import { Router } from 'express';
import { webSearch } from '../services/meshClient.js';

export const imagesRouter = Router();

/**
 * Openverse is keyless and CORS-open, so the client could call it directly —
 * but routing it here keeps the client's network surface to one origin and
 * makes the Mesh option a one-line switch rather than a second code path.
 */
imagesRouter.get('/', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  const source = req.query.source === 'mesh' ? 'mesh' : 'openverse';
  if (!q) return res.json({ results: [] });

  try {
    if (source === 'mesh') {
      const rows = await webSearch({ query: `${q} image`, maxResults: 12 });
      return res.json({
        source,
        results: rows.filter(r => r.image || r.thumbnail).map(r => ({
          url: r.image || r.thumbnail, thumb: r.thumbnail || r.image, title: r.title || q, by: ''
        }))
      });
    }

    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=18&mature=false`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) throw new Error(`Openverse returned ${upstream.status}`);
    const data = await upstream.json();
    res.json({
      source,
      results: (data.results || []).map(r => ({
        url: r.url, thumb: r.thumbnail || r.url, title: r.title || q, by: r.creator || ''
      }))
    });
  } catch (err) { next(err); }
});
