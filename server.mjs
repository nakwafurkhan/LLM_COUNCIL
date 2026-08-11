#!/usr/bin/env node
/**
 * LLM Council — local dev server + Mesh API proxy
 * -----------------------------------------------
 * Why this file exists: api.meshapi.ai refuses cross-origin browser requests
 * ("Disallowed CORS origin"), and Mesh's own docs say never to expose an rsk_
 * key in client-side code. This tiny server sits in between: it serves
 * index.html and forwards /v1/* to Mesh with the CORS headers the browser needs.
 *
 * Requirements: Node 18+ (uses global fetch). Zero npm dependencies.
 *
 *   node server.mjs                 → http://localhost:8787
 *   PORT=3000 node server.mjs       → different port
 *   MESH_API_KEY=rsk_... node server.mjs
 *        ↑ recommended. The key stays on the server; the browser never sees it.
 *          Leave the key field in the UI empty and it still works.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, scrubSettings } from './store.mjs';

const PORT     = Number(process.env.PORT || 8787);
const UPSTREAM = (process.env.MESH_BASE_URL || 'https://api.meshapi.ai').replace(/\/$/, '');
const SERVER_KEY = process.env.MESH_API_KEY || '';
const ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Max-Age', '600');
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const store = await createStore();

const json = (res, code, body) => {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204).end(); return; }

  /* ---------------- history + settings API ---------------- */
  if (url.pathname.startsWith('/api/')) {
    const seg = url.pathname.split('/').filter(Boolean);   // ['api','runs','<id>']
    try {
      if (seg[1] === 'health') {
        return json(res, 200, { ok: true, driver: store.name, detail: store.detail, keyOnServer: !!SERVER_KEY });
      }

      if (seg[1] === 'runs') {
        const id = seg[2];
        if (req.method === 'GET' && !id) {
          const rows = await store.listRuns({
            limit: Number(url.searchParams.get('limit')) || 50,
            mode: url.searchParams.get('mode') || undefined,
            q: url.searchParams.get('q') || undefined
          });
          return json(res, 200, { runs: rows });
        }
        if (req.method === 'GET' && id) {
          const doc = await store.getRun(id);
          return doc ? json(res, 200, doc) : json(res, 404, { error: { message: 'No such run' } });
        }
        if (req.method === 'POST' && !id) {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, await store.saveRun(body));
        }
        if (req.method === 'DELETE' && id) {
          return json(res, 200, { deleted: await store.deleteRun(id) });
        }
        if (req.method === 'DELETE' && !id) {
          return json(res, 200, { deleted: await store.clearRuns() });
        }
      }

      if (seg[1] === 'settings') {
        if (req.method === 'GET') return json(res, 200, (await store.getSettings()) || {});
        if (req.method === 'PUT') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, await store.putSettings(scrubSettings(body)));
        }
      }

      return json(res, 404, { error: { message: 'Unknown API route' } });
    } catch (err) {
      return json(res, 500, { error: { message: err.message } });
    }
  }

  /* ---------------- proxy ---------------- */
  if (url.pathname.startsWith('/v1/')) {
    cors(res);
    const clientKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const key = clientKey || SERVER_KEY;
    if (!key) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No API key. Paste one in the UI, or start the server with MESH_API_KEY=rsk_...' } }));
      return;
    }

    const target = UPSTREAM + url.pathname + url.search;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);

    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Accept': req.headers.accept || '*/*'
        },
        body
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Could not reach ${UPSTREAM}: ${err.message}` } }));
      return;
    }

    const passthrough = ['content-type', 'x-request-id', 'retry-after', 'mesh-version', 'x-provider-latency-ms'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.writeHead(upstream.status);

    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();     // stream SSE straight through, unbuffered
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client hung up mid-stream */ }
    res.end();
    return;
  }

  /* ---------------- static ---------------- */
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  LLM Council  →  http://localhost:${PORT}`);
  console.log(`  proxying /v1/*  →  ${UPSTREAM}/v1/*`);
  console.log(SERVER_KEY
    ? '  key: from MESH_API_KEY (never sent to the browser)'
    : '  key: none on the server — paste your rsk_ key in the app\'s Settings panel');
  console.log('  history: GET/POST /api/runs · settings: GET/PUT /api/settings\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await store.close().catch(() => {}); process.exit(0); });
}
