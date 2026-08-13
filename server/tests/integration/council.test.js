/**
 * Council over the real app.
 *
 * Every degradation path the brief calls for is exercised here: one member
 * rejecting, one timing out, all failing, and the cache.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import { makeTestApp } from "../fixtures/testApp.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { parseSseBody } from "../../src/lib/sse.js";
import { CouncilRun } from "../../src/models/CouncilRun.js";

const A = "openai/gpt-4o";
const B = "openai/gpt-4o-mini";
const C = "anthropic/claude-3-5-sonnet";

const chairmanJson = JSON.stringify({
  answer: "The synthesised answer.",
  disagreements: [
    {
      claim: "whether it is cold",
      positions: [
        { model: A, stance: "cold" },
        { model: B, stance: "mild" },
      ],
    },
  ],
  confidence: "medium",
  confidenceNote: "Members mostly agreed.",
});

let app;
let llm;

beforeEach(() => {
  llm = createFakeLlm();
  llm.script(A, { content: chairmanJson }); // A is also the chairman
  llm.script(B, { content: "Answer from B" });
  llm.script(C, { content: "Answer from C" });
  ({ app } = makeTestApp({ llm }));
});

const post = (body) =>
  request(app)
    .post("/api/council")
    .send({ stream: false, ...body });

describe("a healthy run", () => {
  it("returns member answers plus the chairman synthesis", async () => {
    const res = await post({ prompt: "Is it cold in Oslo?" }).expect(201);

    expect(res.body.memberAnswers).toHaveLength(3);
    expect(res.body.memberAnswers.every((m) => m.status === "fulfilled")).toBe(true);
    expect(res.body.finalAnswer).toBe("The synthesised answer.");
    expect(res.body.partial).toBe(false);
  });

  it("surfaces disagreements as structured data, not buried prose", async () => {
    const res = await post({ prompt: "Is it cold in Oslo?" }).expect(201);
    expect(res.body.disagreements).toHaveLength(1);
    expect(res.body.disagreements[0].claim).toBe("whether it is cold");
    expect(res.body.disagreements[0].positions).toHaveLength(2);
  });

  it("reports cost and latency for every member and the run", async () => {
    const res = await post({ prompt: "Is it cold in Oslo?" }).expect(201);
    for (const member of res.body.memberAnswers) {
      expect(member.costUsd).toBeGreaterThan(0);
      expect(member.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(res.body.totals.costUsd).toBeGreaterThan(0);
  });

  it("persists the run and serves it back by id", async () => {
    const created = await post({ prompt: "Is it cold in Oslo?" }).expect(201);
    const fetched = await request(app).get(`/api/council/${created.body.id}`).expect(200);
    expect(fetched.body.finalAnswer).toBe("The synthesised answer.");

    const list = await request(app).get("/api/council").expect(200);
    expect(list.body.items).toHaveLength(1);
  });
});

describe("degradation", () => {
  it("proceeds when one member rejects, flagging the run partial", async () => {
    llm.script(C, { error: new Error("model exploded") });

    const res = await post({ prompt: "Is it cold in Oslo?" }).expect(201);

    expect(res.body.partial).toBe(true);
    expect(res.body.partialReason).toMatch(/1 of 3/);
    expect(res.body.finalAnswer).toBe("The synthesised answer.");

    const failed = res.body.memberAnswers.find((m) => m.model === C);
    expect(failed.status).toBe("rejected");
    expect(failed.error).toBeTruthy();
  });

  it("proceeds when one member times out", async () => {
    // A hanging model must not hold the run hostage. A short member timeout
    // keeps the test honest without making it slow.
    llm.script(C, { hang: true });
    ({ app } = makeTestApp({ llm, env: { COUNCIL_MEMBER_TIMEOUT_MS: "150" } }));

    const started = Date.now();
    const res = await post({ prompt: "Is it cold?" }).expect(201);

    expect(res.body.partial).toBe(true);
    expect(res.body.memberAnswers.find((m) => m.model === C).status).toBe("timeout");
    // The run finishes on the timeout, not on the hanging model.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still answers with only one surviving member", async () => {
    llm.script(B, { error: new Error("down") });
    llm.script(C, { error: new Error("down") });

    const res = await post({ prompt: "Is it cold?" }).expect(201);
    expect(res.body.partial).toBe(true);
    expect(res.body.finalAnswer).toBeTruthy();
  });

  it("502s only when every member fails", async () => {
    llm.script(A, { error: new Error("down") });
    llm.script(B, { error: new Error("down") });
    llm.script(C, { error: new Error("down") });

    const res = await post({ prompt: "Is it cold?" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("keeps a run whose chairman ignored the JSON format", async () => {
    llm.script(A, { content: "Plain prose, no JSON here." });

    const res = await post({ prompt: "Is it cold?" }).expect(201);
    expect(res.body.finalAnswer).toBe("Plain prose, no JSON here.");
    expect(res.body.disagreements).toEqual([]);
  });
});

describe("caching", () => {
  it("serves an identical second request from cache", async () => {
    const first = await post({ prompt: "Cache me" }).expect(201);
    expect(first.body.cached).toBe(false);

    const callsAfterFirst = llm.calls.length;
    const second = await post({ prompt: "Cache me" }).expect(201);

    expect(second.body.cached).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    // The real assertion: a cache hit costs nothing upstream.
    expect(llm.calls.length).toBe(callsAfterFirst);
    expect(await CouncilRun.countDocuments()).toBe(1);
  });

  it("treats a differently-worded prompt as a miss", async () => {
    await post({ prompt: "Cache me" }).expect(201);
    const other = await post({ prompt: "Something else entirely" }).expect(201);
    expect(other.body.cached).toBe(false);
    expect(await CouncilRun.countDocuments()).toBe(2);
  });

  it("honours bypassCache", async () => {
    await post({ prompt: "Cache me" }).expect(201);
    const forced = await post({ prompt: "Cache me", bypassCache: true }).expect(201);
    expect(forced.body.cached).toBe(false);
    expect(await CouncilRun.countDocuments()).toBe(2);
  });

  it("does not cache when the TTL is zero", async () => {
    ({ app } = makeTestApp({ llm, env: { COUNCIL_CACHE_TTL_MS: "0" } }));
    await post({ prompt: "Cache me" }).expect(201);
    const second = await post({ prompt: "Cache me" }).expect(201);
    expect(second.body.cached).toBe(false);
  });
});

describe("streaming", () => {
  it("emits member cards as they land, then the chairman", async () => {
    const res = await request(app)
      .post("/api/council")
      .send({ prompt: "Stream me" })
      .expect(200);

    const events = parseSseBody(res.text);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("start");
    expect(events.filter((e) => e.event === "member")).toHaveLength(3);
    // Members must all precede the chairman, or the UI's ordering is a lie.
    expect(names.lastIndexOf("member")).toBeLessThan(names.indexOf("chairman-start"));
    expect(names).toContain("chairman-delta");
    expect(names.at(-1)).toBe("done");

    const complete = events.find((e) => e.event === "complete");
    expect(complete.data.finalAnswer).toBe("The synthesised answer.");
  });

  it("streams a failed member as a card rather than dropping it", async () => {
    llm.script(C, { error: new Error("nope") });

    const res = await request(app).post("/api/council").send({ prompt: "Stream" }).expect(200);
    const members = parseSseBody(res.text)
      .filter((e) => e.event === "member")
      .map((e) => e.data.answer);

    expect(members).toHaveLength(3);
    expect(members.find((m) => m.model === C).status).toBe("rejected");
  });

  it("reports total failure as a terminal error event", async () => {
    llm.script(A, { error: new Error("down") });
    llm.script(B, { error: new Error("down") });
    llm.script(C, { error: new Error("down") });

    const res = await request(app).post("/api/council").send({ prompt: "Stream" }).expect(200);
    const failure = parseSseBody(res.text).find((e) => e.event === "error");
    expect(failure.data.error.code).toBe("UPSTREAM_ERROR");
  });
});

describe("validation", () => {
  it("rejects a missing prompt with a field error", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe("prompt");
  });

  it("rejects a member model outside the allowlist", async () => {
    const res = await post({ prompt: "hi", models: ["evil/model"] });
    expect(res.status).toBe(400);
  });

  it("respects an explicit member list", async () => {
    const res = await post({ prompt: "hi", models: [A, B] }).expect(201);
    expect(res.body.memberAnswers).toHaveLength(2);
  });
});
