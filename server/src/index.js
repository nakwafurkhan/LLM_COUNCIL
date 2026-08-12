import { config, assertConfig, dotEnvCount } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { listModels } from './services/meshClient.js';

const problems = assertConfig();
if (problems.length) {
  console.error('\n  Cannot start:\n' + problems.map(p => `   - ${p}`).join('\n') + '\n');
  process.exit(1);
}

try {
  await connectDb();
} catch (err) {
  console.error(`\n  MongoDB connection failed: ${err.message}`);
  console.error('  Check MONGODB_URI, and that your IP is on the Atlas network access list.\n');
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`\n  LLM Council API  →  http://localhost:${config.port}`);
  if (dotEnvCount) console.log(`  .env: loaded ${dotEnvCount} variable${dotEnvCount === 1 ? '' : 's'}`);
  console.log(`  mongo: ${config.mongo.db} (connected)`);
  console.log(`  mesh:  ${config.mesh.baseUrl} — key ${config.mesh.apiKey.slice(0, 8)}…`);
  console.log(config.env === 'production'
    ? '  client: serving the production build from server/public'
    : '  client: run `npm run dev:client` and open http://localhost:5173');
  preflight();
});

/**
 * Ask the gateway one cheap question at boot. Finding out the key is wrong, or
 * that a proxy is breaking TLS, is worth three seconds here rather than after
 * you have typed a question and watched four cards fail.
 */
async function preflight() {
  try {
    const models = await listModels();
    console.log(`  gateway: ok — ${models.length} models visible\n`);
  } catch (err) {
    console.warn(`\n  gateway check FAILED: ${err.message}\n`);
  }
}

/* Let in-flight streams finish rather than cutting them mid-token. */
async function shutdown(signal) {
  console.log(`\n  ${signal} — shutting down`);
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
