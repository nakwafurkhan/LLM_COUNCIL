import mongoose from 'mongoose';
import { config } from './env.js';

/**
 * Mongo is required in this build — there is no file fallback. If the URI is
 * wrong the process exits instead of pretending to work.
 */
export async function connectDb() {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('disconnected', () => console.warn('  [db] disconnected'));
  mongoose.connection.on('reconnected', () => console.log('  [db] reconnected'));

  await mongoose.connect(config.mongo.uri, {
    dbName: config.mongo.db,
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10,
    appName: 'llm-council'
  });

  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.connection.close().catch(() => {});
}
