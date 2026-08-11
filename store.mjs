/**
 * Storage layer for LLM Council.
 *
 * Two drivers behind one interface:
 *   mongo — when MONGODB_URI is set and the `mongodb` package is installed
 *   file  — a JSON file on disk, the zero-setup default
 *
 * Everything the server persists goes through here, so adding a third driver
 * later means implementing six methods and nothing else.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/* Read env lazily, never at module scope. ES imports are evaluated before the
   importing module's body runs, so anything captured here would be read before
   server.mjs has loaded .env — which silently ignored COUNCIL_DB_FILE and the
   MONGODB_* names. Functions, not constants. */
const dbName   = () => process.env.MONGODB_DB       || 'llm_council';
const runsColl = () => process.env.MONGODB_RUNS     || 'runs';
const setColl  = () => process.env.MONGODB_SETTINGS || 'settings';
const filePath = () => resolve(process.env.COUNCIL_DB_FILE || './council-data.json');

/* A settings blob must never carry the Mesh key to the server. Belt and braces:
   the client strips it before sending, and we strip it again on arrival. */
const SECRET_KEYS = ['apiKey', 'api_key', 'key', 'token', 'authorization'];
export function scrubSettings(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.includes(k)) continue;
    if (typeof v === 'string' && /^rsk_|^sk-/.test(v.trim())) continue;
    out[k] = v;
  }
  return out;
}

/* normalise whatever the client posts into a storable run */
function normaliseRun(run = {}) {
  const now = new Date().toISOString();
  return {
    id: run.id || randomUUID(),
    createdAt: run.createdAt || now,
    updatedAt: now,
    mode: String(run.mode || 'quick'),
    prompt: String(run.prompt || '').slice(0, 20000),
    title: String(run.title || run.prompt || '').slice(0, 200),
    models: Array.isArray(run.models) ? run.models.slice(0, 24) : [],
    payload: run.payload && typeof run.payload === 'object' ? run.payload : {},
    ms: Number(run.ms) || 0
  };
}

/* ------------------------------------------------------------------ file */
function fileDriver() {
  const FILE_PATH = filePath();
  let cache = null;
  let writing = Promise.resolve();

  async function read() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(FILE_PATH, 'utf8'));
    } catch {
      cache = { runs: [], settings: null };
    }
    if (!Array.isArray(cache.runs)) cache.runs = [];
    return cache;
  }
  /* serialise writes, and write-then-rename so a crash cannot truncate the file */
  function flush() {
    writing = writing.then(async () => {
      await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {});
      const tmp = FILE_PATH + '.tmp';
      await writeFile(tmp, JSON.stringify(cache, null, 2));
      await rename(tmp, FILE_PATH);
    }).catch(err => console.error('  [store] write failed:', err.message));
    return writing;
  }

  return {
    name: 'file',
    detail: FILE_PATH,
    async init() { await read(); },
    async listRuns({ limit = 50, mode, q } = {}) {
      const db = await read();
      let rows = [...db.runs];
      if (mode) rows = rows.filter(r => r.mode === mode);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(r =>
          (r.title || '').toLowerCase().includes(needle) ||
          (r.prompt || '').toLowerCase().includes(needle));
      }
      rows.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      return rows.slice(0, limit).map(({ payload, ...meta }) => meta);
    },
    async getRun(id) {
      const db = await read();
      return db.runs.find(r => r.id === id) || null;
    },
    async saveRun(run) {
      const db = await read();
      const doc = normaliseRun(run);
      const i = db.runs.findIndex(r => r.id === doc.id);
      if (i >= 0) db.runs[i] = doc; else db.runs.unshift(doc);
      if (db.runs.length > 500) db.runs.length = 500;
      await flush();
      return doc;
    },
    async deleteRun(id) {
      const db = await read();
      const before = db.runs.length;
      db.runs = db.runs.filter(r => r.id !== id);
      await flush();
      return before !== db.runs.length;
    },
    async clearRuns() {
      const db = await read();
      const n = db.runs.length;
      db.runs = [];
      await flush();
      return n;
    },
    async getSettings() {
      const db = await read();
      return db.settings;
    },
    async putSettings(s) {
      const db = await read();
      db.settings = { ...scrubSettings(s), updatedAt: new Date().toISOString() };
      await flush();
      return db.settings;
    },
    async close() { await writing; }
  };
}

/* ----------------------------------------------------------------- mongo */
async function mongoDriver(uri) {
  let MongoClient;
  try {
    ({ MongoClient } = await import('mongodb'));
  } catch {
    throw new Error("MONGODB_URI is set but the 'mongodb' package is not installed. Run: npm install mongodb");
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
    appName: 'llm-council'
  });
  await client.connect();
  const db = client.db(dbName());
  const runs = db.collection(runsColl());
  const settings = db.collection(setColl());

  await runs.createIndex({ createdAt: -1 }).catch(() => {});
  await runs.createIndex({ id: 1 }, { unique: true }).catch(() => {});
  await runs.createIndex({ mode: 1, createdAt: -1 }).catch(() => {});
  /* text index powers ?q= search; ignored if the tier disallows it */
  await runs.createIndex({ title: 'text', prompt: 'text' }).catch(() => {});

  const strip = ({ _id, ...rest }) => rest;

  return {
    name: 'mongo',
    detail: `${dbName()}.${runsColl()}`,
    async init() {},
    async listRuns({ limit = 50, mode, q } = {}) {
      const filter = {};
      if (mode) filter.mode = mode;
      if (q) filter.$or = [
        { title:  { $regex: q, $options: 'i' } },
        { prompt: { $regex: q, $options: 'i' } }
      ];
      const rows = await runs.find(filter, { projection: { payload: 0 } })
        .sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray();
      return rows.map(strip);
    },
    async getRun(id) {
      const doc = await runs.findOne({ id });
      return doc ? strip(doc) : null;
    },
    async saveRun(run) {
      const doc = normaliseRun(run);
      await runs.replaceOne({ id: doc.id }, doc, { upsert: true });
      return doc;
    },
    async deleteRun(id) {
      const r = await runs.deleteOne({ id });
      return r.deletedCount > 0;
    },
    async clearRuns() {
      const r = await runs.deleteMany({});
      return r.deletedCount;
    },
    async getSettings() {
      const doc = await settings.findOne({ _id: 'singleton' });
      return doc ? strip(doc) : null;
    },
    async putSettings(s) {
      const value = { ...scrubSettings(s), updatedAt: new Date().toISOString() };
      await settings.replaceOne({ _id: 'singleton' }, { _id: 'singleton', ...value }, { upsert: true });
      return value;
    },
    async close() { await client.close(); }
  };
}

/* --------------------------------------------------------------- factory */
export async function createStore() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const store = await mongoDriver(uri);
      console.log(`  store: mongodb → ${store.detail}`);
      return store;
    } catch (err) {
      /* A bad connection string should not cost you the whole app. Say so loudly,
         then keep going on the file driver. */
      console.error(`  store: mongodb unavailable (${err.message})`);
      console.error('  store: falling back to the local file');
    }
  }
  const store = fileDriver();
  await store.init();
  console.log(`  store: file → ${store.detail}`);
  return store;
}
