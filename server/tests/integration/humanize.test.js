/**
 * The humanizer over the real app.
 *
 * The three passes are the feature, so most of these check that all three
 * happen, that their output is preserved, and that a failure in one does not
 * throw away the others.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import { makeTestApp } from "../fixtures/testApp.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { parseSseBody } from "../../src/lib/sse.js";
import { HumanizerRun } from "../../src/models/HumanizerRun.js";

const MODEL = "openai/gpt-4o";

/** Text with several mechanically detectable tells. */
const AI_TEXT =
  "It's not just a tool—it's a testament to innovation. " +
  "Let's dive in. In order to leverage this vibrant, groundbreaking landscape, " +
  "experts argue that teams must foster seamless collaboration, " +
  "showcasing speed, quality, and scale.";

const CLEAN_DRAFT = "The tool speeds up boring work. It does not help with architecture.";
const CLEAN_FINAL = "The tool speeds up boring work. It won't help you with architecture.";

const AUDIT_JSON = JSON.stringify({
  notes: ["The opening still reads like a summary", "Second sentence is oddly flat"],
});

let app;
let llm;

/** Script the fake to answer each pass by what the prompt asks for. */
function scriptPasses({ draft = CLEAN_DRAFT, audit = AUDIT_JSON, final = CLEAN_FINAL } = {}) {
  llm.script(MODEL, {
    content: (messages) => {
      const prompt = messages.map((m) => m.content).join("\n");
      if (prompt.includes("What makes the text below so obviously AI generated?")) return audit;
      if (prompt.includes("You are revising text")) return final;
      return draft;
    },
  });
}

beforeEach(() => {
  llm = createFakeLlm();
  scriptPasses();
  ({ app } = makeTestApp({ llm }));
});

const post = (body) =>
  request(app)
    .post("/api/humanize")
    .send({ stream: false, ...body });

describe("a healthy run", () => {
  it("returns all three passes, not just the final text", async () => {
    const res = await post({ text: AI_TEXT }).expect(201);

    expect(res.body.draft).toBe(CLEAN_DRAFT);
    expect(res.body.final).toBe(CLEAN_FINAL);
    expect(res.body.audit.notes).toHaveLength(2);
    expect(res.body.original).toBe(AI_TEXT);
  });

  it("makes three model calls, one per pass", async () => {
    await post({ text: AI_TEXT }).expect(201);
    expect(llm.calls).toHaveLength(3);
  });

  it("feeds the audit's findings into the revision prompt", async () => {
    // Otherwise the third pass is just a second draft and the audit is theatre.
    await post({ text: AI_TEXT }).expect(201);
    const revisionPrompt = llm.calls[2].messages.map((m) => m.content).join("\n");
    expect(revisionPrompt).toContain("The opening still reads like a summary");
  });

  it("reports the pattern count before and after", async () => {
    const res = await post({ text: AI_TEXT }).expect(201);

    expect(res.body.before.total).toBeGreaterThan(0);
    expect(res.body.after.total).toBe(0);
    expect(res.body.diff.delta).toBeGreaterThan(0);
    expect(res.body.diff.removed.length).toBeGreaterThan(0);
  });

  it("names the specific patterns it found in the original", async () => {
    const res = await post({ text: AI_TEXT }).expect(201);
    const ids = res.body.before.findings.map((f) => f.id);
    expect(ids).toContain("em-dash");
    expect(ids).toContain("negative-parallelism");
    expect(ids).toContain("signposting");
  });

  it("records cost and latency", async () => {
    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.usage.costUsd).toBeGreaterThan(0);
    expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("persists the run and serves it back", async () => {
    const created = await post({ text: AI_TEXT }).expect(201);
    const fetched = await request(app).get(`/api/humanize/${created.body.id}`).expect(200);
    expect(fetched.body.final).toBe(CLEAN_FINAL);
    expect((await request(app).get("/api/humanize")).body.items).toHaveLength(1);
  });
});

describe("voice calibration", () => {
  it("puts the sample in the draft prompt and flags that one was used", async () => {
    const res = await post({
      text: AI_TEXT,
      voiceSample: "I write short. Mostly. Sometimes I ramble a bit but not often.",
    }).expect(201);

    expect(res.body.voiceSampleUsed).toBe(true);
    const draftPrompt = llm.calls[0].messages.map((m) => m.content).join("\n");
    expect(draftPrompt).toContain("I write short");
  });

  it("does not store the sample, which is the user's own writing", async () => {
    const created = await post({ text: AI_TEXT, voiceSample: "my private draft" }).expect(201);
    const stored = await HumanizerRun.findById(created.body.id).lean();
    expect(JSON.stringify(stored)).not.toContain("my private draft");
    expect(stored.voiceSampleUsed).toBe(true);
  });

  it("works without a sample", async () => {
    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.voiceSampleUsed).toBe(false);
  });
});

describe("tone", () => {
  it("passes the requested tone into the prompt", async () => {
    await post({ text: AI_TEXT, tone: "technical" }).expect(201);
    const prompt = llm.calls[0].messages.map((m) => m.content).join("\n");
    expect(prompt).toMatch(/knowledgeable reader/i);
  });

  it("rejects a tone that is not on the list", async () => {
    const res = await post({ text: AI_TEXT, tone: "swashbuckling" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe("tone");
  });
});

describe("degradation", () => {
  it("keeps the draft when the audit pass fails", async () => {
    // Two good passes should not be thrown away by a failure in the third.
    let call = 0;
    llm.script(MODEL, {
      content: () => {
        call += 1;
        if (call === 1) return CLEAN_DRAFT;
        throw new Error("audit exploded");
      },
    });

    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.final).toBe(CLEAN_DRAFT);
    expect(res.body.partial).toBe(true);
    expect(res.body.partialReason).toMatch(/audit/i);
  });

  it("salvages notes from a prose audit that ignored the JSON format", async () => {
    scriptPasses({
      audit: "- The opening is too tidy and summary-like\n- The rhythm never varies at all",
    });

    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.audit.notes.length).toBeGreaterThan(0);
    expect(res.body.audit.notes[0]).toMatch(/tidy/);
    expect(res.body.partial).toBe(false);
  });

  it("accepts an empty audit as a legitimate verdict", async () => {
    // "Nothing left to fix" is a real answer, not a failure.
    scriptPasses({ audit: JSON.stringify({ notes: [] }) });

    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.audit.notes).toEqual([]);
    expect(res.body.partial).toBe(false);
    expect(res.body.final).toBe(CLEAN_FINAL);
  });

  it("falls back to the draft when the revision returns nothing", async () => {
    scriptPasses({ final: "   " });

    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.final).toBe(CLEAN_DRAFT);
    expect(res.body.partial).toBe(true);
  });

  it("502s when the draft pass fails, since there is nothing to show", async () => {
    llm.script(MODEL, { error: new Error("provider down") });

    const res = await post({ text: AI_TEXT });
    expect(res.status).toBe(502);
  });

  it("reports when the rewrite introduced new tells", async () => {
    // A rewrite can make things worse. Hiding that would be dishonest.
    scriptPasses({
      draft: "Plain text.",
      final: "Let's dive in — it's not just plain, it's vibrant.",
    });

    const res = await post({ text: "Ordinary sentence." }).expect(201);
    expect(res.body.diff.introduced.length).toBeGreaterThan(0);
    expect(res.body.diff.delta).toBeLessThan(0);
  });
});

describe("output cleaning", () => {
  it("strips code fences the model added anyway", async () => {
    scriptPasses({ final: "```\nThe clean text.\n```" });
    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.final).toBe("The clean text.");
  });

  it("strips the triple-quote delimiter used in the prompt", async () => {
    scriptPasses({ final: '"""\nThe clean text.\n"""' });
    const res = await post({ text: AI_TEXT }).expect(201);
    expect(res.body.final).toBe("The clean text.");
  });
});

describe("streaming", () => {
  it("emits the three passes in order", async () => {
    const res = await request(app).post("/api/humanize").send({ text: AI_TEXT }).expect(200);

    const events = parseSseBody(res.text);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("start");
    // Each pass streams, then lands.
    expect(names).toContain("draft-delta");
    expect(names).toContain("draft");
    expect(names).toContain("audit");
    expect(names).toContain("final-delta");
    expect(names.at(-1)).toBe("done");

    // Ordering is the contract the UI renders against.
    expect(names.indexOf("draft")).toBeLessThan(names.indexOf("audit"));
    expect(names.indexOf("audit")).toBeLessThan(names.lastIndexOf("final-delta"));
  });

  it("sends the before-analysis up front, so the UI can show it immediately", async () => {
    const res = await request(app).post("/api/humanize").send({ text: AI_TEXT }).expect(200);
    const start = parseSseBody(res.text).find((e) => e.event === "start");
    expect(start.data.before.total).toBeGreaterThan(0);
    expect(start.data.model).toBe(MODEL);
  });

  it("delivers the audit notes as a list, not raw JSON", async () => {
    const res = await request(app).post("/api/humanize").send({ text: AI_TEXT }).expect(200);
    const audit = parseSseBody(res.text).find((e) => e.event === "audit");
    expect(audit.data.notes).toHaveLength(2);
  });

  it("reports a failure as a terminal error event", async () => {
    llm.script(MODEL, { error: new Error("down") });
    const res = await request(app).post("/api/humanize").send({ text: AI_TEXT }).expect(200);
    const failure = parseSseBody(res.text).find((e) => e.event === "error");
    expect(failure.data.error.code).toBe("UPSTREAM_ERROR");
  });
});

describe("validation", () => {
  it("rejects empty text with a field error", async () => {
    const res = await post({ text: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe("text");
  });

  it("rejects text over the size cap", async () => {
    const res = await post({ text: "x".repeat(60_000) });
    expect(res.status).toBe(400);
  });

  it("rejects a model outside the allowlist", async () => {
    const res = await post({ text: AI_TEXT, model: "evil/model" });
    expect(res.status).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });

  it("404s an unknown run and 400s a malformed id", async () => {
    expect((await request(app).get("/api/humanize/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await request(app).get("/api/humanize/nope")).status).toBe(400);
  });
});
