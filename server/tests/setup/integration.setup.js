/**
 * Integration harness.
 *
 * A real Mongo (in memory), a real Express app, and the fake LLM adapter.
 * The only thing not real is the model provider — which is exactly the line
 * the brief draws: no test may make a network call to MeshAPI or GitHub.
 */
import { beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "llm_council_test" });
}, 120_000);

afterEach(async () => {
  // Truncate rather than drop: recreating indexes for every test is slow, and
  // a stale index is a bug worth catching anyway.
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
