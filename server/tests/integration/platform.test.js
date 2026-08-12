/**
 * Cross-cutting behaviour: health, error shape, rate limiting, request ids,
 * and the PR job's read/stream endpoints.
 *
 * These are the things every route depends on and no single feature test
 * covers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

import { makeTestApp } from "../fixtures/testApp.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { loadConfig } from "../../src/config/env.js";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/lib/logger.js";
import { TEST_ENV } from "../fixtures/testApp.js";
import { parseSseBody } from "../../src/lib/sse.js";
import { NotFoundError } from "../../src/lib/errors.js";

let app;
let llm;

beforeEach(() => {
  llm = createFakeLlm();
  llm.script("*", { content: "ok" });
  ({ app } = makeTestApp({ llm }));
});

describe("GET /api/health", () => {
  it("reports ok with Mongo connected", async () => {
    const res = await request(app).get("/api/health").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.checks.mongo.ok).toBe(true);
    expect(res.body.checks.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reports which subsystems are configured without echoing any value", async () => {
    const { app: configured } = makeTestApp({
      llm,
      env: {
        GITHUB_TOKEN: "ghp_secretvalue000000000000000000000000",
        GITHUB_OWNER: "o",
        GITHUB_REPO: "r",
        REPO_LOCAL_PATH: "/tmp/x",
      },
    });

    const res = await request(configured).get("/api/health").expect(200);

    expect(res.body.checks.config.githubConfigured).toBe(true);
    expect(res.body.checks.config.repoConfigured).toBe(true);
    expect(res.body.checks.config.meshApiKeyConfigured).toBe(true);
    // Presence is the whole answer; the value must never appear.
    expect(res.text).not.toContain("ghp_");
    expect(res.text).not.toContain("rsk_");
  });

  it("lists the configured models so a deploy can be checked at a glance", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.checks.models.chat).toBe("openai/gpt-4o");
    expect(res.body.checks.models.quick).toBe("openai/gpt-4o-mini");
    expect(res.body.checks.models.council).toHaveLength(3);
  });

  it("degrades to 503 when Mongo is unreachable", async () => {
    // Health that stays green while the database is down is worse than none.
    // readyState is a prototype accessor, so shadow it with an own property
    // and delete that afterwards — assigning a plain value back would leave a
    // non-writable property that breaks mongoose's own disconnect.
    Object.defineProperty(mongoose.connection, "readyState", {
      value: 0,
      configurable: true,
    });

    try {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.mongo.ok).toBe(false);
    } finally {
      delete mongoose.connection.readyState;
    }
  });
});

/** A minimal app whose only route throws, wired to the real error handler. */
async function appThatThrows(message, isProduction) {
  const express = (await import("express")).default;
  const { errorHandler } = await import("../../src/middleware/errorHandler.js");
  const { requestId } = await import("../../src/middleware/requestId.js");

  const app = express();
  app.use(requestId());
  app.get("/explode", () => {
    throw new Error(message);
  });
  app.use(errorHandler({ logger: createLogger({ level: "silent" }), isProduction }));
  return app;
}

describe("error handling", () => {
  it("404s an unknown route in the standard envelope", async () => {
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("rejects malformed JSON as a 400, not a 500", async () => {
    const res = await request(app)
      .post("/api/conversations")
      .set("content-type", "application/json")
      .send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });

  it("rejects an oversized body", async () => {
    const { app: tiny } = makeTestApp({ llm, env: { BODY_LIMIT: "1kb" } });
    const res = await tiny && (await request(tiny).post("/api/council").send({ prompt: "x".repeat(5_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("never leaks a stack trace in production", async () => {
    // buildApp mounts its 404 handler last, so a route added afterwards is
    // unreachable. Exercise the terminal handler directly instead.
    const boom = await appThatThrows("internal detail that must not escape", true);
    const res = await request(boom).get("/explode");
    expect(res.status).toBe(500);
    expect(res.body.error.stack).toBeUndefined();
    expect(res.text).not.toContain("internal detail");
    expect(res.body.error.message).toMatch(/something went wrong/i);
  });

  it("includes a stack in development, where it is useful", async () => {
    const dev = await appThatThrows("dev detail", false);
    const res = await request(dev).get("/explode");
    expect(res.status).toBe(500);
    expect(Array.isArray(res.body.error.stack)).toBe(true);
  });
});

describe("request ids", () => {
  it("mints one and echoes it on the response", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honours a sane inbound id so a trace can span services", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("x-request-id", "trace-abc-123")
      .expect(200);
    expect(res.headers["x-request-id"]).toBe("trace-abc-123");
  });

  it("replaces a hostile inbound id rather than reflecting it", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("x-request-id", "<script>alert(1)</script>")
      .expect(200);
    expect(res.headers["x-request-id"]).not.toContain("<script>");
  });
});

describe("rate limiting", () => {
  it("429s after the configured burst, in the standard envelope", async () => {
    const { app: limited } = makeTestApp({
      llm,
      env: { RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" },
    });

    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await request(limited).get("/api/conversations")).status);
    }

    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.at(-1)).toBe(429);

    const res = await request(limited).get("/api/conversations");
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("limits council more tightly than the API generally", async () => {
    const { app: limited } = makeTestApp({
      llm,
      env: { RATE_LIMIT_MAX: "100", RATE_LIMIT_COUNCIL_MAX: "1" },
    });

    await request(limited).post("/api/council").send({ prompt: "one", stream: false });
    const second = await request(limited)
      .post("/api/council")
      .send({ prompt: "two", stream: false });

    // Council spends real money per call, so it gets its own tighter bucket.
    expect(second.status).toBe(429);
  });

  it("never throttles health checks", async () => {
    const { app: limited } = makeTestApp({ llm, env: { RATE_LIMIT_MAX: "1" } });
    for (let i = 0; i < 5; i++) {
      await request(limited).get("/api/health").expect(200);
    }
  });
});

describe("PR read and stream endpoints", () => {
  /** A stub service, so these can be tested without a git fixture. */
  function stubService(overrides = {}) {
    const listeners = new Set();
    return {
      createJob: async () => ({ job: { _id: "job-1", status: "queued" }, reused: false }),
      enqueue: () => {},
      listJobs: async () => [
        { _id: "job-1", task: "t", branch: "b", status: "completed", prUrl: "u", createdAt: new Date() },
      ],
      getJob: async (id) => {
        if (id === "aaaaaaaaaaaaaaaaaaaaaaaa") throw new NotFoundError("PR job not found");
        return {
          _id: id,
          task: "Do a thing",
          status: "planning",
          files: [],
          timeline: [],
        };
      },
      approve: async () => ({ _id: "job-1", status: "completed" }),
      reject: async () => ({ _id: "job-1", status: "cancelled" }),
      subscribe: (_id, fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      emit: (event) => listeners.forEach((fn) => fn(event)),
      ...overrides,
    };
  }

  function appWithStub(stub) {
    const config = loadConfig(TEST_ENV);
    return buildApp({ config, llm, logger: createLogger({ level: "silent" }), codePr: stub });
  }

  it("lists jobs", async () => {
    const res = await request(appWithStub(stubService())).get("/api/pr").expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("completed");
  });

  it("404s an unknown job", async () => {
    const res = await request(appWithStub(stubService())).get(
      "/api/pr/aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed job id", async () => {
    const res = await request(appWithStub(stubService())).get("/api/pr/not-an-id");
    expect(res.status).toBe(400);
  });

  it("streams status changes and closes on a terminal state", async () => {
    const stub = stubService();
    const server = appWithStub(stub);

    // .then() is what actually dispatches a supertest request; without it the
    // emits below would fire before the handler had subscribed.
    const pending = request(server)
      .get("/api/pr/bbbbbbbbbbbbbbbbbbbbbbbb/stream")
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    stub.emit({ status: "generating", note: "writing files" });
    stub.emit({ status: "awaiting_approval", note: "ready for review" });

    const res = await pending;
    const events = parseSseBody(res.text);

    expect(events[0].data.status).toBe("planning");
    expect(events.some((e) => e.data.status === "generating")).toBe(true);
    // A terminal state must end the stream, or the socket is held open for a
    // job that will never change again.
    expect(events.at(-1).event).toBe("done");
  });

  it("closes immediately for a job that is already finished", async () => {
    const stub = stubService({
      getJob: async (id) => ({ _id: id, task: "t", status: "completed", files: [], timeline: [] }),
    });

    const res = await request(appWithStub(stub)).get("/api/pr/bbbbbbbbbbbbbbbbbbbbbbbb/stream");
    const events = parseSseBody(res.text);
    expect(events.at(-1).event).toBe("done");
    expect(events.at(-1).data.status).toBe("completed");
  });
});
