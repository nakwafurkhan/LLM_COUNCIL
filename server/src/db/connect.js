/**
 * Mongo connection lifecycle.
 *
 * `index.js` owns calling these. Nothing else opens or closes a connection —
 * integration tests point MONGODB_URI at mongodb-memory-server and use the
 * same code path the real server does.
 */
import mongoose from "mongoose";
import { logger as defaultLogger } from "../lib/logger.js";

/** Fail fast rather than buffering commands against a dead socket forever. */
const DEFAULTS = {
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  maxPoolSize: 10,
};

export async function connectDb(config, { logger = defaultLogger } = {}) {
  mongoose.set("strictQuery", true);
  // Surfaces a clear error instead of a silent 10s hang when Mongo is down.
  mongoose.set("bufferCommands", false);

  const conn = await mongoose.connect(config.MONGODB_URI, {
    ...DEFAULTS,
    dbName: config.MONGODB_DB,
  });

  logger.info({ db: config.MONGODB_DB, host: conn.connection.host }, "mongo connected");

  mongoose.connection.on("error", (err) => logger.error({ err }, "mongo error"));
  mongoose.connection.on("disconnected", () => logger.warn("mongo disconnected"));

  return conn;
}

export async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/** Connection state for the health route. */
export function dbStatus() {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const readyState = mongoose.connection.readyState;
  return {
    ok: readyState === 1,
    state: states[readyState] ?? "unknown",
    name: mongoose.connection.name ?? null,
  };
}

/** Liveness ping — readyState alone can lie after a network partition. */
export async function pingDb() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
