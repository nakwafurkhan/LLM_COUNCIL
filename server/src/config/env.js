import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

/**
 * Minimal .env loader. Node only gained `process.loadEnvFile()` in 20.12, and
 * `--env-file` in 20.6 — this keeps Node 18 working without adding dotenv.
 * Real environment variables always win over the file.
 */
function loadDotEnv() {
  const file = [join(REPO_ROOT, '.env'), join(SERVER_ROOT, '.env')].find(existsSync);
  if (!file) return 0;
  let n = 0;
  for (let line of readFileSync(file, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) { process.env[key] = val; n++; }
  }
  return n;
}

export const dotEnvCount = loadDotEnv();

const int = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 8787),

  mesh: {
    baseUrl: (process.env.MESH_BASE_URL || 'https://api.meshapi.ai').replace(/\/+$/, ''),
    apiKey: process.env.MESH_API_KEY || '',
    timeoutMs: int(process.env.MESH_TIMEOUT_MS, 120000)
  },

  mongo: {
    uri: process.env.MONGODB_URI || '',
    db: process.env.MONGODB_DB || 'llm_council'
  },

  /* Origins allowed to call the API. In dev the Vite server is a different
     origin; in production Express serves the built client, so same-origin. */
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean),

  publicDir: join(SERVER_ROOT, 'public')
};

/** Fail fast and loudly rather than dying with an obscure error later. */
export function assertConfig() {
  const problems = [];
  if (!config.mongo.uri) {
    problems.push('MONGODB_URI is not set. Copy .env.example to .env and add your connection string.');
  }
  if (!config.mesh.apiKey) {
    problems.push('MESH_API_KEY is not set. The server cannot reach the gateway without it.');
  }
  return problems;
}
