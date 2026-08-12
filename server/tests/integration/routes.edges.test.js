/**
 * Route branches the feature suites do not reach: optional query parameters,
 * per-request model overrides, and the error paths of every mutating verb.
 *
 * These are the paths that only run on a bad day, which is exactly why they
 * are worth pinning.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import { makeTestApp } from "../fixtures/testApp.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { Conversation } from "../../src/models/Conversation.js";

let app;
let llm;

beforeEach(() => {
  llm = createFakeLlm();
  llm.script("*", { content: "ok" });
  ({ app } = makeTestApp({ llm }));
});

const newConversation = async (mode = "chat") =>
  (await request(app).post("/api/conversations").send({ mode }).expect(201)).body;

describe("conversation listing filters", () => {
  it("filters by mode", async () => {
    await newConversation("chat");
    await newConversation("quick");

    const chats = await request(app).get("/api/conversations?mode=chat").expect(200);
    expect(chats.body.items).toHaveLength(1);
    expect(chats.body.items[0].mode).toBe("chat");
  });

  it("honours limit", async () => {
    await newConversation("chat");
    await newConversation("chat");
    await newConversation("chat");

    const res = await request(app).get("/api/conversations?limit=2").expect(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("rejects a limit outside the allowed range", async () => {
    expect((await request(app).get("/api/conversations?limit=0")).status).toBe(400);
    expect((await request(app).get("/api/conversations?limit=500")).status).toBe(400);
  });

  it("accepts an explicit title on creation", async () => {
    const res = await request(app)
      .post("/api/conversations")
      .send({ mode: "chat", title: "Named up front" })
      .expect(201);
    expect(res.body.title).toBe("Named up front");
  });
});

describe("per-request model override", () => {
  it("uses an allowed override for one turn without changing the conversation", async () => {
    const c = await newConversation("chat");

    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi", model: "openai/gpt-4o-mini", stream: false })
      .expect(201);

    expect(llm.calledModels).toEqual(["openai/gpt-4o-mini"]);
    // The override is per-request; the conversation's own model is unchanged.
    const reloaded = await Conversation.findById(c.id);
    expect(reloaded.model).toBe("openai/gpt-4o");
  });

  it("rejects an override outside the allowlist", async () => {
    const c = await newConversation("chat");
    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi", model: "evil/model", stream: false });
    expect(res.status).toBe(400);
    // Nothing was sent upstream.
    expect(llm.calls).toHaveLength(0);
  });

  it("accepts a model override on regenerate", async () => {
    const c = await newConversation("chat");
    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi", stream: false });

    await request(app)
      .post(`/api/conversations/${c.id}/regenerate`)
      .send({ model: "openai/gpt-4o-mini" })
      .expect(200);

    expect(llm.calledModels.at(-1)).toBe("openai/gpt-4o-mini");
  });
});

describe("mutating verbs on missing resources", () => {
  const missing = "aaaaaaaaaaaaaaaaaaaaaaaa";

  it("404s posting to a missing conversation", async () => {
    const res = await request(app)
      .post(`/api/conversations/${missing}/messages`)
      .send({ content: "hi", stream: false });
    expect(res.status).toBe(404);
  });

  it("404s streaming to a missing conversation, as JSON not SSE", async () => {
    const res = await request(app)
      .post(`/api/conversations/${missing}/messages`)
      .send({ content: "hi" });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("404s archiving, deleting and regenerating a missing conversation", async () => {
    expect((await request(app).post(`/api/conversations/${missing}/archive`)).status).toBe(404);
    expect((await request(app).delete(`/api/conversations/${missing}`)).status).toBe(404);
    expect((await request(app).post(`/api/conversations/${missing}/regenerate`).send({})).status).toBe(
      404,
    );
  });

  it("404s a missing council run and 400s a malformed id", async () => {
    expect((await request(app).get(`/api/council/${missing}`)).status).toBe(404);
    expect((await request(app).get("/api/council/nope")).status).toBe(400);
  });

  it("404s messages for a missing conversation rather than returning an empty list", async () => {
    // An empty list would imply the conversation exists and is empty.
    const res = await request(app).get(`/api/conversations/${missing}/messages`);
    expect(res.status).toBe(404);
  });
});

describe("council list paging", () => {
  it("honours limit and rejects an out-of-range one", async () => {
    await request(app).post("/api/council").send({ prompt: "one", stream: false });
    await request(app).post("/api/council").send({ prompt: "two", stream: false });

    const res = await request(app).get("/api/council?limit=1").expect(200);
    expect(res.body.items).toHaveLength(1);
    expect((await request(app).get("/api/council?limit=0")).status).toBe(400);
  });

  it("returns an empty list before any run exists", async () => {
    const res = await request(app).get("/api/council").expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("Code+PR without a configured repo", () => {
  it("400s rather than failing obscurely deeper in the pipeline", async () => {
    // REPO_LOCAL_PATH is unset in the default test env.
    const res = await request(app)
      .post("/api/pr")
      .send({ task: "Do something to a repository that is not configured" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/REPO_LOCAL_PATH/);
  });

  it("404s approving or rejecting a job that does not exist", async () => {
    const { app: withRepo } = makeTestApp({ llm, env: { REPO_LOCAL_PATH: "/tmp" } });
    const missing = "aaaaaaaaaaaaaaaaaaaaaaaa";
    expect((await request(withRepo).post(`/api/pr/${missing}/approve`)).status).toBe(404);
    expect((await request(withRepo).post(`/api/pr/${missing}/reject`)).status).toBe(404);
  });

  it("returns an empty job list before any job exists", async () => {
    const res = await request(app).get("/api/pr").expect(200);
    expect(res.body.items).toEqual([]);
  });
});
