/**
 * The provider adapter.
 *
 * Two layers:
 *  - classification and the model allowlist, tested directly;
 *  - the real adapter against an msw-intercepted HTTP endpoint, so retry,
 *    backoff, timeout and 429 handling are exercised over a genuine request
 *    path rather than a hand-mocked SDK.
 *
 * No test here reaches the network.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

import { createMeshAdapter, backoffMs } from "../../src/services/llm/meshAdapter.js";
import { resolveModel } from "../../src/services/llm/index.js";
import { isRetryable, retryAfterMs, toAppError } from "../../src/services/llm/errors.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { TimeoutError, UpstreamError, ValidationError } from "../../src/lib/errors.js";
import { registerSecret, clearSecrets } from "../../src/lib/redact.js";

const BASE_URL = "https://api.meshapi.test/v1";
const MODEL = "openai/gpt-4o";

const config = {
  MESH_API_KEY: "rsk_test_secret_value_abcdef123456",
  MESH_BASE_URL: BASE_URL,
  MESH_TIMEOUT_MS: 1_000,
  MESH_MAX_RETRIES: 2,
  allowedModels: [MODEL, "openai/gpt-4o-mini"],
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  clearSecrets();
});
afterAll(() => server.close());

/** A minimal well-formed completion body. */
const completion = (content = "hello") => ({
  id: "cmpl_1",
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

describe("resolveModel", () => {
  it("falls back to the mode default when the client asks for nothing", () => {
    expect(resolveModel(undefined, MODEL, config.allowedModels)).toBe(MODEL);
  });

  it("honours an allowed request", () => {
    expect(resolveModel("openai/gpt-4o-mini", MODEL, config.allowedModels)).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("rejects anything outside the allowlist rather than forwarding it", () => {
    // Forwarding a raw client string would let a caller bill us for any model
    // the router happens to expose.
    expect(() => resolveModel("evil/expensive-model", MODEL, config.allowedModels)).toThrow(
      ValidationError,
    );
  });

  it("names the permitted models in the error", () => {
    try {
      resolveModel("nope/nope", MODEL, config.allowedModels);
    } catch (err) {
      expect(err.fields[0].path).toBe("model");
      expect(err.fields[0].message).toContain("openai/gpt-4o-mini");
    }
  });
});

describe("error classification", () => {
  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [408, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])("status %i retryable=%s", (status, expected) => {
    expect(isRetryable({ status })).toBe(expected);
  });

  it("retries transient socket errors", () => {
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryable({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("never retries an abort", () => {
    // An abort means either we timed out or the caller left. Neither improves
    // by asking again.
    expect(isRetryable({ name: "AbortError" })).toBe(false);
  });

  it("reads Retry-After in seconds and as a date", () => {
    expect(retryAfterMs({ headers: { "retry-after": "2" } })).toBe(2_000);
    const future = new Date(Date.now() + 5_000).toUTCString();
    expect(retryAfterMs({ headers: { "retry-after": future } })).toBeGreaterThan(3_000);
    expect(retryAfterMs({})).toBeNull();
  });

  it("maps statuses onto the taxonomy", () => {
    expect(toAppError({ status: 400, message: "bad" }, { model: MODEL })).toBeInstanceOf(
      ValidationError,
    );
    expect(toAppError({ status: 500, message: "boom" }, { model: MODEL })).toBeInstanceOf(
      UpstreamError,
    );
    expect(toAppError({ name: "AbortError" }, { model: MODEL })).toBeInstanceOf(TimeoutError);
  });

  it("does not echo a credential out of a provider error", () => {
    registerSecret(config.MESH_API_KEY);
    const err = toAppError(
      { status: 500, message: `upstream said: Authorization: Bearer ${config.MESH_API_KEY}` },
      { model: MODEL },
    );
    expect(err.message).not.toContain(config.MESH_API_KEY);
  });

  it("keeps auth failures vague, since the detail may quote the key", () => {
    const err = toAppError({ status: 401, message: "invalid key rsk_abc" }, { model: MODEL });
    expect(err.message).toMatch(/MESH_API_KEY/);
    expect(err.message).not.toContain("rsk_abc");
  });
});

describe("backoff", () => {
  it("grows with the attempt number and stays capped", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffMs(0)).toBe(250);
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1_000);
    expect(backoffMs(10)).toBe(8_000); // capped
    spy.mockRestore();
  });

  it("jitters, so a fleet of clients does not retry in lockstep", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffMs(5)).toBe(0);
    spy.mockRestore();
  });
});

describe("askModel over HTTP", () => {
  it("returns content, usage and cost", async () => {
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () =>
        HttpResponse.json(completion("hi there")),
      ),
    );

    const adapter = createMeshAdapter({ config });
    const result = await adapter.askModel({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hi there");
    expect(result.usage.promptTokens).toBe(11);
    expect(result.usage.completionTokens).toBe(7);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("retries a 429 and then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse(JSON.stringify({ error: "slow down" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return HttpResponse.json(completion("recovered"));
      }),
    );

    const adapter = createMeshAdapter({ config });
    const result = await adapter.askModel({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(attempts).toBe(2);
    expect(result.content).toBe("recovered");
  });

  it("gives up after the configured retry budget", async () => {
    let attempts = 0;
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const adapter = createMeshAdapter({
      config: { ...config, MESH_MAX_RETRIES: 1 },
    });

    await expect(
      adapter.askModel({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(UpstreamError);
    // Initial attempt plus one retry.
    expect(attempts).toBe(2);
  });

  it("does NOT retry a 400", async () => {
    let attempts = 0;
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        attempts += 1;
        return HttpResponse.json({ error: { message: "bad request" } }, { status: 400 });
      }),
    );

    const adapter = createMeshAdapter({ config });
    await expect(
      adapter.askModel({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Retrying a malformed request just buys the same answer more slowly.
    expect(attempts).toBe(1);
  });

  it("maps a slow provider to TimeoutError", async () => {
    server.use(
      http.post(`${BASE_URL}/chat/completions`, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json(completion());
      }),
    );

    const adapter = createMeshAdapter({
      config: { ...config, MESH_TIMEOUT_MS: 50, MESH_MAX_RETRIES: 0 },
    });

    await expect(
      adapter.askModel({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("estimates usage when the provider omits it", async () => {
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () =>
        HttpResponse.json({
          id: "x",
          model: MODEL,
          choices: [{ message: { content: "abcd" }, finish_reason: "stop" }],
        }),
      ),
    );

    const adapter = createMeshAdapter({ config });
    const result = await adapter.askModel({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.completionTokens).toBe(1);
  });
});

describe("listModels", () => {
  it("falls back to the configured allowlist when listing fails", async () => {
    server.use(http.get(`${BASE_URL}/models`, () => new HttpResponse(null, { status: 500 })));
    const adapter = createMeshAdapter({ config });
    // A convenience endpoint must never take the app down.
    await expect(adapter.listModels()).resolves.toEqual(config.allowedModels);
  });
});

describe("the fake adapter honours the same contract", () => {
  it("returns scripted content and records the call", async () => {
    const llm = createFakeLlm();
    llm.script(MODEL, { content: "scripted" });

    const res = await llm.askModel({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("scripted");
    expect(llm.calledModels).toEqual([MODEL]);
  });

  it("streams deltas and terminates with a done chunk", async () => {
    const llm = createFakeLlm();
    llm.script(MODEL, { chunks: ["one ", "two ", "three"] });

    const seen = [];
    for await (const chunk of llm.streamModel({ model: MODEL, messages: [] })) seen.push(chunk);

    expect(seen.filter((c) => c.type === "delta").map((c) => c.text)).toEqual([
      "one ",
      "two ",
      "three",
    ]);
    const done = seen.at(-1);
    expect(done.type).toBe("done");
    expect(done.content).toBe("one two three");
  });

  it("can be scripted to fail, then recover", async () => {
    const llm = createFakeLlm();
    llm.script(MODEL, { error: new Error("transient"), failTimes: 1, content: "ok" });

    await expect(llm.askModel({ model: MODEL, messages: [] })).rejects.toBeInstanceOf(
      UpstreamError,
    );
    await expect(llm.askModel({ model: MODEL, messages: [] })).resolves.toMatchObject({
      content: "ok",
    });
  });
});
