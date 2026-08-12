/**
 * Chat and Quick over the real Express app.
 *
 * Real router, real middleware, real Mongo. Only the model provider is fake.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import { makeTestApp } from "../fixtures/testApp.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { parseSseBody } from "../../src/lib/sse.js";
import { Message } from "../../src/models/Message.js";

let app;
let llm;

beforeEach(() => {
  llm = createFakeLlm();
  llm.script("*", { content: "The fake model replies." });
  ({ app } = makeTestApp({ llm }));
});

const newConversation = async (mode = "chat") => {
  const res = await request(app).post("/api/conversations").send({ mode }).expect(201);
  return res.body;
};

describe("conversation lifecycle", () => {
  it("creates a conversation with the mode's default model", async () => {
    const chat = await newConversation("chat");
    expect(chat.mode).toBe("chat");
    expect(chat.model).toBe("openai/gpt-4o");
    expect(chat.title).toBe("New conversation");

    const quick = await newConversation("quick");
    expect(quick.model).toBe("openai/gpt-4o-mini");
  });

  it("rejects an unknown mode with field-level detail", async () => {
    const res = await request(app).post("/api/conversations").send({ mode: "telepathy" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields[0].path).toBe("mode");
  });

  it("refuses a model outside the allowlist", async () => {
    // A raw client-supplied model must never reach the provider.
    const res = await request(app)
      .post("/api/conversations")
      .send({ mode: "chat", model: "evil/gpt-9" });
    expect(res.status).toBe(400);
  });

  it("404s for a conversation that does not exist", async () => {
    const res = await request(app).get("/api/conversations/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400s for a malformed id rather than 500ing on a cast error", async () => {
    const res = await request(app).get("/api/conversations/not-an-id");
    expect(res.status).toBe(400);
  });

  it("lists, archives and deletes", async () => {
    const c = await newConversation("chat");
    expect((await request(app).get("/api/conversations")).body.items).toHaveLength(1);

    await request(app).post(`/api/conversations/${c.id}/archive`).expect(200);
    expect((await request(app).get("/api/conversations")).body.items).toHaveLength(0);
    expect(
      (await request(app).get("/api/conversations?includeArchived=true")).body.items,
    ).toHaveLength(1);

    await request(app).delete(`/api/conversations/${c.id}`).expect(200);
    expect((await request(app).get("/api/conversations")).body.items).toHaveLength(0);
  });
});

describe("posting a message (non-streaming)", () => {
  it("persists both the user turn and the assistant reply", async () => {
    const c = await newConversation("chat");

    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "What is a council?", stream: false })
      .expect(201);

    expect(res.body.message.role).toBe("assistant");
    expect(res.body.message.content).toBe("The fake model replies.");

    const { body } = await request(app).get(`/api/conversations/${c.id}/messages`).expect(200);
    expect(body.items.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(body.items[0].content).toBe("What is a council?");
  });

  it("titles the conversation from the first user message", async () => {
    const c = await newConversation("chat");
    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "How do I deploy this to production?", stream: false })
      .expect(201);

    const { body } = await request(app).get(`/api/conversations/${c.id}`);
    expect(body.title).toBe("How do I deploy this to production?");
  });

  it("records tokens and cost on the message and the conversation", async () => {
    const c = await newConversation("chat");
    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hello", stream: false })
      .expect(201);

    expect(res.body.message.costUsd).toBeGreaterThan(0);
    expect(res.body.conversation.totalCostUsd).toBeGreaterThan(0);
  });

  it("rejects an empty message with a field error, not a 500", async () => {
    const c = await newConversation("chat");
    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "   ", stream: false });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe("content");
  });

  it("rejects an oversized prompt", async () => {
    const c = await newConversation("chat");
    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "x".repeat(40_000), stream: false });
    expect(res.status).toBe(400);
  });

  it("sends prior turns back as context on the next request", async () => {
    const c = await newConversation("chat");
    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "first question", stream: false });
    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "second question", stream: false });

    // Server-side history is the point: the browser sent only the new turn.
    const secondCall = llm.calls[1];
    const contents = secondCall.messages.map((m) => m.content);
    expect(contents).toContain("first question");
    expect(contents).toContain("The fake model replies.");
    expect(contents).toContain("second question");
  });
});

describe("quick vs chat", () => {
  it("resolves different models through the same code path", async () => {
    const chat = await newConversation("chat");
    const quick = await newConversation("quick");

    await request(app)
      .post(`/api/conversations/${chat.id}/messages`)
      .send({ content: "hi", stream: false });
    await request(app)
      .post(`/api/conversations/${quick.id}/messages`)
      .send({ content: "hi", stream: false });

    expect(llm.calledModels).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });

  it("gives quick a lower token ceiling and a shorter timeout", async () => {
    const chat = await newConversation("chat");
    const quick = await newConversation("quick");

    await request(app)
      .post(`/api/conversations/${chat.id}/messages`)
      .send({ content: "hi", stream: false });
    await request(app)
      .post(`/api/conversations/${quick.id}/messages`)
      .send({ content: "hi", stream: false });

    const [chatCall, quickCall] = llm.calls;
    expect(quickCall.options.maxTokens).toBeLessThan(chatCall.options.maxTokens);
    expect(quickCall.options.timeoutMs).toBeLessThan(chatCall.options.timeoutMs);
  });

  it("gives quick a terser system prompt", async () => {
    const quick = await newConversation("quick");
    await request(app)
      .post(`/api/conversations/${quick.id}/messages`)
      .send({ content: "hi", stream: false });

    const system = llm.calls[0].messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/terse/i);
  });

  it("costs measurably less per turn, which is the entire point of the mode", async () => {
    const chat = await newConversation("chat");
    const quick = await newConversation("quick");

    const chatRes = await request(app)
      .post(`/api/conversations/${chat.id}/messages`)
      .send({ content: "hi", stream: false });
    const quickRes = await request(app)
      .post(`/api/conversations/${quick.id}/messages`)
      .send({ content: "hi", stream: false });

    expect(quickRes.body.message.costUsd).toBeLessThan(chatRes.body.message.costUsd);
  });
});

describe("streaming", () => {
  it("emits deltas then a terminal event", async () => {
    llm.script("*", { chunks: ["Hello", " ", "world"] });
    const c = await newConversation("chat");

    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSseBody(res.text);
    const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.text);
    expect(deltas).toEqual(["Hello", " ", "world"]);

    const message = events.find((e) => e.event === "message");
    expect(message.data.content).toBe("Hello world");
    expect(message.data.usage.costUsd).toBeGreaterThan(0);
    expect(events.at(-1).event).toBe("done");
  });

  it("persists the assistant message when the stream completes", async () => {
    llm.script("*", { chunks: ["persisted"] });
    const c = await newConversation("chat");

    await request(app).post(`/api/conversations/${c.id}/messages`).send({ content: "hi" });

    const { body } = await request(app).get(`/api/conversations/${c.id}/messages`);
    expect(body.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "persisted",
      interrupted: false,
    });
  });

  it("reports a mid-stream failure as a terminal error event", async () => {
    // Headers are already sent, so the error cannot travel as a status code.
    llm.script("*", { error: new Error("provider exploded") });
    const c = await newConversation("chat");

    const res = await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi" })
      .expect(200);

    const events = parseSseBody(res.text);
    const failure = events.find((e) => e.event === "error");
    expect(failure).toBeDefined();
    expect(failure.data.error.code).toBe("UPSTREAM_ERROR");
  });

  it("still 400s on a bad body before committing to SSE", async () => {
    const c = await newConversation("chat");
    const res = await request(app).post(`/api/conversations/${c.id}/messages`).send({});
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

describe("regenerate", () => {
  it("supersedes the previous answer and produces a new one", async () => {
    const c = await newConversation("chat");
    await request(app)
      .post(`/api/conversations/${c.id}/messages`)
      .send({ content: "hi", stream: false });

    llm.script("*", { content: "A different answer." });
    const res = await request(app).post(`/api/conversations/${c.id}/regenerate`).send({});

    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe("A different answer.");

    // The visible transcript has one assistant turn; the old one is retained
    // but marked superseded rather than destroyed.
    const { body } = await request(app).get(`/api/conversations/${c.id}/messages`);
    expect(body.items.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(await Message.countDocuments({ supersededAt: { $ne: null } })).toBe(1);
  });

  it("404s when there is nothing to regenerate", async () => {
    const c = await newConversation("chat");
    const res = await request(app).post(`/api/conversations/${c.id}/regenerate`).send({});
    expect(res.status).toBe(404);
  });
});
