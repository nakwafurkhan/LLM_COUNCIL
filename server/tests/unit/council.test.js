/**
 * Council internals.
 *
 * The interesting cases are all failure cases: a council that only works when
 * every model behaves is a council that will fail in production on its first
 * bad afternoon.
 */
import { describe, it, expect } from "vitest";

import {
  hashRun,
  mapWithConcurrency,
  parseChairmanOutput,
  buildChairmanPrompt,
} from "../../src/services/council.js";

describe("hashRun", () => {
  const base = {
    prompt: "What is the capital of France?",
    models: ["openai/gpt-4o", "openai/gpt-4o-mini"],
    chairmanModel: "openai/gpt-4o",
  };

  it("is stable for the same inputs", () => {
    expect(hashRun(base)).toBe(hashRun({ ...base }));
  });

  it("ignores member order, which is not semantically meaningful", () => {
    expect(hashRun({ ...base, models: [...base.models].reverse() })).toBe(hashRun(base));
  });

  it("normalises whitespace and case", () => {
    expect(hashRun({ ...base, prompt: "  what is   the CAPITAL of France?  " })).toBe(
      hashRun(base),
    );
  });

  it("changes when the question, the members, or the chairman change", () => {
    expect(hashRun({ ...base, prompt: "different" })).not.toBe(hashRun(base));
    expect(hashRun({ ...base, models: ["openai/gpt-4o"] })).not.toBe(hashRun(base));
    expect(hashRun({ ...base, chairmanModel: "anthropic/claude-3-5-sonnet" })).not.toBe(
      hashRun(base),
    );
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      },
    );

    // Without this ceiling a large council 429s itself against the router.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (5 - n) * 5));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

describe("parseChairmanOutput", () => {
  const valid = {
    answer: "Paris.",
    disagreements: [
      { claim: "population figure", positions: [{ model: "a", stance: "2.1M" }] },
    ],
    confidence: "high",
    confidenceNote: "All members agreed.",
  };

  it("parses bare JSON", () => {
    const out = parseChairmanOutput(JSON.stringify(valid));
    expect(out.parsed).toBe(true);
    expect(out.answer).toBe("Paris.");
    expect(out.disagreements).toHaveLength(1);
  });

  it("parses JSON inside a fenced code block", () => {
    const out = parseChairmanOutput("```json\n" + JSON.stringify(valid) + "\n```");
    expect(out.parsed).toBe(true);
    expect(out.confidence).toBe("high");
  });

  it("parses JSON buried after a prose preamble", () => {
    const out = parseChairmanOutput(`Sure! Here is my synthesis:\n${JSON.stringify(valid)}`);
    expect(out.parsed).toBe(true);
  });

  it("falls back to raw text rather than failing the run", () => {
    // A perfectly good answer that ignored the format instruction must not
    // discard the whole (expensive) run.
    const out = parseChairmanOutput("The capital of France is Paris.");
    expect(out.parsed).toBe(false);
    expect(out.answer).toBe("The capital of France is Paris.");
    expect(out.disagreements).toEqual([]);
    expect(out.confidenceNote).toMatch(/not structured/i);
  });

  it("falls back when JSON is malformed", () => {
    const out = parseChairmanOutput('{"answer": "truncated...');
    expect(out.parsed).toBe(false);
    expect(out.answer).toContain("truncated");
  });

  it("falls back when JSON is well-formed but the wrong shape", () => {
    const out = parseChairmanOutput('{"result": "no answer field"}');
    expect(out.parsed).toBe(false);
  });

  it("defaults optional fields", () => {
    const out = parseChairmanOutput('{"answer": "Just an answer."}');
    expect(out.parsed).toBe(true);
    expect(out.disagreements).toEqual([]);
    expect(out.confidence).toBe("medium");
  });

  it("handles empty input", () => {
    expect(parseChairmanOutput("").parsed).toBe(false);
    expect(parseChairmanOutput(null).answer).toBe("");
  });
});

describe("buildChairmanPrompt", () => {
  const answers = [
    { model: "a", status: "fulfilled", content: "Answer A" },
    { model: "b", status: "rejected", content: "", error: "boom" },
    { model: "c", status: "timeout", content: "", error: "timed out" },
    { model: "d", status: "fulfilled", content: "Answer D" },
  ];

  it("includes only members that answered", () => {
    const [, user] = buildChairmanPrompt("Question?", answers);
    expect(user.content).toContain("Answer A");
    expect(user.content).toContain("Answer D");
    // A failed member contributes nothing but noise, and inviting the chairman
    // to reason about an empty answer invites it to hallucinate one.
    expect(user.content).not.toContain("boom");
    expect(user.content).not.toContain("timed out");
  });

  it("labels each answer with its model", () => {
    const [, user] = buildChairmanPrompt("Question?", answers);
    expect(user.content).toContain("Member 1 — a");
    expect(user.content).toContain("Member 2 — d");
  });

  it("asks for structured output including disagreements", () => {
    const [system] = buildChairmanPrompt("Q", answers);
    expect(system.content).toMatch(/disagreements/);
    expect(system.content).toMatch(/JSON/);
  });
});
