/**
 * Scriptable fake LLM adapter.
 *
 * Implements the same interface as the Mesh adapter, so it can be handed to
 * `buildApp()` in place of the real thing. Every LLM-touching test uses this;
 * no test in this repo makes a real model call.
 *
 * Behaviour is scripted per model, which is what makes the interesting council
 * cases expressible: one member fast, one slow, one erroring, one hanging past
 * its timeout.
 *
 *   const llm = createFakeLlm();
 *   llm.script("openai/gpt-4o", { content: "hello" });
 *   llm.script("anthropic/claude-3-5-sonnet", { error: new Error("boom") });
 *   llm.script("openai/gpt-4o-mini", { latencyMs: 5_000 });  // will time out
 *
 * Also records every call, so tests can assert *which* model was used and what
 * transcript it received — that is how "quick and chat share one code path but
 * resolve different models" gets proved.
 */
import { normalizeUsage } from "../../src/lib/tokenCost.js";
import { UpstreamError, TimeoutError } from "../../src/lib/errors.js";

/** Default reply when a model has no script. */
const DEFAULT_REPLY = "This is a fake model response.";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });

/**
 * @typedef {object} ModelScript
 * @property {string}   [content]      Text to return.
 * @property {Error}    [error]        Throw instead of answering.
 * @property {number}   [latencyMs]    Simulated delay before answering.
 * @property {boolean}  [hang]         Never resolve (until aborted).
 * @property {number}   [failTimes]    Fail this many times, then succeed.
 * @property {number}   [status]       Status to attach to the thrown error.
 * @property {string[]} [chunks]       Explicit stream chunks.
 * @property {object}   [usage]        Usage object to report.
 */

export function createFakeLlm(initialScripts = {}) {
  /** @type {Map<string, ModelScript>} */
  const scripts = new Map(Object.entries(initialScripts));
  /** @type {Array<{model: string, messages: any[], stream: boolean, options: object}>} */
  const calls = [];
  const failureCounts = new Map();

  function scriptFor(model) {
    return scripts.get(model) ?? scripts.get("*") ?? {};
  }

  /** Apply latency/error/hang. Shared by ask and stream so both behave alike. */
  async function applyBehaviour(model, signal, timeoutMs) {
    const s = scriptFor(model);

    if (s.hang) {
      // Simulate a provider that never answers. The real adapter enforces the
      // deadline itself, so the fake has to as well — otherwise a "hanging
      // model" test just hangs the suite instead of exercising the timeout.
      if (timeoutMs != null) {
        await sleep(timeoutMs, signal);
        throw Object.assign(new Error("simulated provider timeout"), { name: "AbortError" });
      }
      // No deadline was passed: hang, deliberately. A caller that omits a
      // timeout has a bug, and hiding it here would let that bug ship.
      await sleep(3_600_000, signal);
    }
    if (s.latencyMs) await sleep(s.latencyMs, signal);

    if (s.error) {
      const seen = failureCounts.get(model) ?? 0;
      const shouldFail = s.failTimes == null || seen < s.failTimes;
      failureCounts.set(model, seen + 1);
      if (shouldFail) {
        const err = s.error instanceof Error ? s.error : new Error(String(s.error));
        if (s.status != null && err.status == null) err.status = s.status;
        throw err;
      }
    }
  }

  function replyFor(model, messages) {
    const s = scriptFor(model);
    if (typeof s.content === "function") return s.content(messages);
    if (s.content != null) return s.content;
    if (s.chunks) return s.chunks.join("");
    return DEFAULT_REPLY;
  }

  return {
    name: "fake",

    /* ---- test controls ---------------------------------------------- */

    /** Script a model's behaviour. Pass "*" as a catch-all. */
    script(model, behaviour) {
      scripts.set(model, behaviour);
      return this;
    },
    /** Every call made, in order. */
    get calls() {
      return calls;
    },
    /** Models called, in order, deduped is left to the caller. */
    get calledModels() {
      return calls.map((c) => c.model);
    },
    reset() {
      calls.length = 0;
      scripts.clear();
      failureCounts.clear();
      return this;
    },

    /* ---- adapter interface ------------------------------------------ */

    async askModel({ model, messages, maxTokens, timeoutMs, signal, ...rest }) {
      calls.push({
        model,
        messages,
        stream: false,
        options: { maxTokens, timeoutMs, ...rest },
      });
      const startedAt = Date.now();

      try {
        await applyBehaviour(model, signal, timeoutMs);
      } catch (err) {
        if (err.name === "AbortError") {
          throw new TimeoutError(`Model ${model} did not respond within ${timeoutMs}ms`);
        }
        throw new UpstreamError(`Model ${model} failed: ${err.message}`, { cause: err });
      }

      const content = replyFor(model, messages);
      const s = scriptFor(model);

      return {
        content,
        model,
        finishReason: "stop",
        usage: normalizeUsage(s.usage, {
          model,
          promptText: messages.map((m) => m.content).join("\n"),
          completionText: content,
        }),
        latencyMs: Date.now() - startedAt,
      };
    },

    async *streamModel({ model, messages, maxTokens, timeoutMs, signal, ...rest }) {
      calls.push({ model, messages, stream: true, options: { maxTokens, timeoutMs, ...rest } });
      const startedAt = Date.now();

      try {
        await applyBehaviour(model, signal, timeoutMs);
      } catch (err) {
        if (err.name === "AbortError") {
          throw new TimeoutError(`Model ${model} did not respond within ${timeoutMs}ms`);
        }
        throw new UpstreamError(`Model ${model} failed: ${err.message}`, { cause: err });
      }

      const s = scriptFor(model);
      const full = replyFor(model, messages);
      // Word-wise chunking approximates real token streaming closely enough
      // for the client to be exercised meaningfully.
      const chunks = s.chunks ?? full.match(/\S+\s*/g) ?? [full];

      let content = "";
      for (const text of chunks) {
        if (signal?.aborted) break;
        if (s.chunkDelayMs) await sleep(s.chunkDelayMs, signal);
        content += text;
        yield { type: "delta", text };
      }

      yield {
        type: "done",
        content,
        model,
        finishReason: signal?.aborted ? "interrupted" : "stop",
        usage: normalizeUsage(s.usage, {
          model,
          promptText: messages.map((m) => m.content).join("\n"),
          completionText: content,
        }),
        latencyMs: Date.now() - startedAt,
      };
    },

    async listModels() {
      return Array.from(scripts.keys()).filter((m) => m !== "*");
    },
  };
}
