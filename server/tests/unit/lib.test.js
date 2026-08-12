/**
 * Dependency-free primitives: cost math, the SSE wire format, and the error
 * taxonomy's status mapping.
 */
import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  estimateTokens,
  sumUsage,
  normalizeUsage,
  priceFor,
  isEstimatedPrice,
  FALLBACK_PRICE,
} from "../../src/lib/tokenCost.js";
import { parseSseBody } from "../../src/lib/sse.js";
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
  isAppError,
} from "../../src/lib/errors.js";

describe("tokenCost", () => {
  it("prices a completion from the table", () => {
    // gpt-4o is $2.50/1M in, $10/1M out.
    expect(
      estimateCostUsd({ model: "openai/gpt-4o", promptTokens: 1e6, completionTokens: 1e6 }),
    ).toBe(12.5);
    expect(
      estimateCostUsd({ model: "openai/gpt-4o-mini", promptTokens: 1e6, completionTokens: 0 }),
    ).toBe(0.15);
  });

  it("is zero for an empty completion", () => {
    expect(
      estimateCostUsd({ model: "openai/gpt-4o", promptTokens: 0, completionTokens: 0 }),
    ).toBe(0);
  });

  it("falls back to a mid-range price for an unknown model", () => {
    expect(isEstimatedPrice("openai/gpt-4o")).toBe(false);
    expect(isEstimatedPrice("someone/brand-new-model")).toBe(true);
    expect(priceFor("someone/brand-new-model")).toEqual(FALLBACK_PRICE);
  });

  it("estimates tokens at roughly 4 characters each", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("sums usage across council members without float drift", () => {
    expect(
      sumUsage([
        { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
        { promptTokens: 1, completionTokens: 1, costUsd: 0.002 },
      ]),
    ).toEqual({ promptTokens: 11, completionTokens: 6, costUsd: 0.003 });
    expect(sumUsage([])).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it("prefers reported usage and estimates only when it is absent", () => {
    const reported = normalizeUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { model: "openai/gpt-4o" },
    );
    expect(reported).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      estimated: false,
    });

    // Streaming responses routinely omit usage — a cost is still recorded.
    const estimated = normalizeUsage(undefined, {
      model: "openai/gpt-4o",
      promptText: "abcd",
      completionText: "abcdabcd",
    });
    expect(estimated).toMatchObject({ promptTokens: 1, completionTokens: 2, estimated: true });
  });
});

describe("parseSseBody", () => {
  it("parses events and skips heartbeat comments", () => {
    const body =
      'event: delta\ndata: {"text":"hi"}\n\n: ping\n\nevent: done\ndata: {"ok":true}\n\n';
    expect(parseSseBody(body)).toEqual([
      { event: "delta", data: { text: "hi" } },
      { event: "done", data: { ok: true } },
    ]);
  });

  it("leaves non-JSON data as text", () => {
    expect(parseSseBody("event: note\ndata: plain text\n\n")).toEqual([
      { event: "note", data: "plain text" },
    ]);
  });
});

describe("error taxonomy", () => {
  it.each([
    [new ValidationError(), 400, "VALIDATION_ERROR"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new RateLimitError(), 429, "RATE_LIMITED"],
    [new UpstreamError(), 502, "UPSTREAM_ERROR"],
    [new TimeoutError(), 504, "TIMEOUT"],
    [new AppError("boom"), 500, "INTERNAL_ERROR"],
  ])("%s maps to its status and code", (err, status, code) => {
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(isAppError(err)).toBe(true);
  });

  it("only exposes messages that are safe to show a caller", () => {
    // A generic 500 must never hand its message to a client.
    expect(new AppError("connection string was mongodb://...").expose).toBe(false);
    // These are deliberately actionable, so they do cross the wire.
    expect(new UpstreamError().expose).toBe(true);
    expect(new TimeoutError().expose).toBe(true);
    expect(new ValidationError().expose).toBe(true);
  });

  it("carries field lists on validation errors", () => {
    const err = new ValidationError("Invalid request body", [
      { path: "prompt", message: "must not be empty" },
    ]);
    expect(err.fields).toHaveLength(1);
    expect(err.details.fields[0].path).toBe("prompt");
  });

  it("is not confused by a plain Error", () => {
    expect(isAppError(new Error("plain"))).toBe(false);
  });
});
