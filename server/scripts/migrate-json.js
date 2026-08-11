#!/usr/bin/env node
/**
 * Import history from the v1 file store (council-data.json) into MongoDB.
 *
 *   node server/scripts/migrate-json.js [path/to/council-data.json]
 *
 * Safe to re-run: documents are matched on their original createdAt + prompt,
 * so a second pass updates rather than duplicating.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { config, assertConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Run } from '../src/models/Run.js';
import { parseStudyPack, parseHumanized } from '../src/utils/parse.js';

const source = resolve(process.argv[2] || './council-data.json');

/* v1 stored a loose payload blob; v2 has typed fields per mode. */
function convert(old) {
  const base = {
    mode: old.mode,
    prompt: old.prompt || '',
    title: old.title || '',
    imageUrl: old.payload?.image || '',
    models: old.models || [],
    ms: old.ms || 0,
    status: 'complete',
    createdAt: old.createdAt ? new Date(old.createdAt) : new Date()
  };
  const p = old.payload || {};

  if (old.mode === 'quick') return { ...base, answer: p.text || '' };

  if (old.mode === 'council') {
    return {
      ...base,
      seats: (p.seats || []).map((s, i) => ({
        index: i, model: s.model, text: s.text || '', ms: 0, firstTokenMs: 0, error: ''
      })),
      ranking: (p.ranking || []).map(r => ({
        index: r.idx ?? r.index, model: r.model, mean: r.mean || 0,
        votes: r.count ?? r.votes ?? 0, rank: r.rank || 0, critiques: r.comments || r.critiques || []
      })),
      chair: p.chair ? { model: p.chair.model, text: p.chair.text } : undefined
    };
  }

  if (old.mode === 'study') return { ...base, study: parseStudyPack(p.raw || '') };
  if (old.mode === 'humanize') return { ...base, humanize: parseHumanized(p.raw || '') };
  return base;
}

const problems = assertConfig().filter(p => p.includes('MONGODB_URI'));
if (problems.length) {
  console.error(`\n  ${problems[0]}\n`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(await readFile(source, 'utf8'));
} catch (err) {
  console.error(`\n  Could not read ${source}: ${err.message}\n`);
  process.exit(1);
}

const rows = Array.isArray(raw.runs) ? raw.runs : [];
if (!rows.length) {
  console.log('\n  Nothing to import — the file has no runs.\n');
  process.exit(0);
}

await connectDb();
console.log(`\n  Importing ${rows.length} run(s) into ${config.mongo.db}…`);

let imported = 0;
let skipped = 0;
for (const old of rows) {
  try {
    const doc = convert(old);
    await Run.findOneAndUpdate(
      { createdAt: doc.createdAt, prompt: doc.prompt },
      doc,
      /* timestamps:false so the original createdAt survives the import —
         otherwise every migrated run would claim to be from today. */
      { upsert: true, setDefaultsOnInsert: true, timestamps: false }
    );
    imported += 1;
  } catch (err) {
    skipped += 1;
    console.warn(`  skipped one run: ${err.message}`);
  }
}

/* Settings carried over too, minus anything key-shaped (the model strips it). */
if (raw.settings) {
  const { Setting } = await import('../src/models/Setting.js');
  await Setting.write(raw.settings);
  console.log('  settings imported');
}

console.log(`  done — ${imported} imported${skipped ? `, ${skipped} skipped` : ''}\n`);
await disconnectDb();
await mongoose.disconnect().catch(() => {});
process.exit(0);
