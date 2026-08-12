/**
 * The provider adapter — the ONLY module in the codebase that imports the
 * `openai` SDK.
 *
 * Everything else talks to this interface:
 *
 *   askModel({ model, messages, ... })    -> { content, usage, latencyMs }
 *   streamModel({ model, messages, ... }) -> async iterable of chunks
 *   listModels()                          -> string[]
 *
 * Keeping the surface this narrow is what lets tests substitute a fake with no
 * module mocking, and what stops provider quirks leaking into route handlers.
 *
 * Two behaviours are enforced here rather than left to callers, because the
 * original server.js had neither:
 *   - every call has a timeout;
 *   - retries are bounded, backed off, and only for failures worth retrying.
 */
import OpenAI from "openai";

import { normalizeUsage } from "../../lib/tokenCost.js";
import { logger as defaultLogger } from "../../lib/logger.js";
import { TimeoutError } from "../../lib/errors.js";
import { isRetryable, retryAfterMs, toAppError, statusOf } from "./errors.js";

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt, { base = 250, cap = 8_000 } = {}) {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
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
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} [deps.logger]
 * @param {object} [deps.client] Inject a client in tests instead of mocking.
 */
export function createMeshAdapter({ config, logger = defaultLogger, client } = {}) {
  const openai =
    client ??
    new OpenAI({
      apiKey: config.MESH_API_KEY,
      baseURL: config.MESH_BASE_URL,
      // We own retries; the SDK's would multiply with ours and blow the budget.
      maxRetries: 0,
    });

  /**
   * Run `fn` with a timeout and bounded retries.
   * `fn` receives an AbortSignal it must pass upstream.
   */
  async function withResilience(fn, { model, timeoutMs, maxRetries, signal }) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timer = new AbortController();
      const onOuterAbort = () => timer.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      // Track our own timeout rather than inferring it from the thrown error:
      // SDKs wrap aborts in their own error types (APIUserAbortError here), so
      // sniffing for `name === "AbortError"` silently misclassifies a timeout
      // as a generic upstream failure.
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        timer.abort();
      }, timeoutMs);

      try {
        return await fn(timer.signal);
      } catch (err) {
        lastError = err;

        // A timeout has already consumed the caller's whole budget; spending
        // another full window on a retry is rarely what anyone wants.
        if (timedOut) {
          throw new TimeoutError(`Model ${model} did not respond within ${timeoutMs}ms`, {
            cause: err,
          });
        }

        // The caller hung up: not our failure to retry.
        if (signal?.aborted) throw toAppError(err, { model, timeoutMs });

        const retryable = isRetryable(err);
        const attemptsLeft = attempt < maxRetries;

        logger.warn(
          {
            model,
            attempt: attempt + 1,
            status: statusOf(err),
            retryable,
            willRetry: retryable && attemptsLeft,
            err,
          },
          "llm call failed",
        );

        if (!retryable || !attemptsLeft) throw toAppError(err, { model, timeoutMs });

        const wait = retryAfterMs(err) ?? backoffMs(attempt);
        await sleep(wait, signal);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }

    throw toAppError(lastError, { model, timeoutMs });
  }

  return {
    name: "mesh",

    /** Single-shot completion. */
    async askModel({
      model,
      messages,
      maxTokens,
      temperature,
      responseFormat,
      timeoutMs = config.MESH_TIMEOUT_MS,
      maxRetries = config.MESH_MAX_RETRIES,
      signal,
    }) {
      const startedAt = Date.now();

      const response = await withResilience(
        (abortSignal) =>
          openai.chat.completions.create(
            {
              model,
              messages,
              ...(maxTokens ? { max_tokens: maxTokens } : {}),
              ...(temperature != null ? { temperature } : {}),
              ...(responseFormat ? { response_format: responseFormat } : {}),
            },
            { signal: abortSignal },
          ),
        { model, timeoutMs, maxRetries, signal },
      );

      const content = response?.choices?.[0]?.message?.content ?? "";
      const promptText = messages.map((m) => m.content).join("\n");

      return {
        content,
        model: response?.model ?? model,
        finishReason: response?.choices?.[0]?.finish_reason ?? null,
        usage: normalizeUsage(response?.usage, {
          model,
          promptText,
          completionText: content,
        }),
        latencyMs: Date.now() - startedAt,
      };
    },

    /**
     * Streaming completion.
     *
     * Yields `{ type: "delta", text }` per token chunk and exactly one
     * `{ type: "done", content, usage, latencyMs }` at the end. Callers rely
     * on that terminal chunk to persist the finished message.
     */
    async *streamModel({
      model,
      messages,
      maxTokens,
      temperature,
      timeoutMs = config.MESH_TIMEOUT_MS,
      maxRetries = config.MESH_MAX_RETRIES,
      signal,
    }) {
      const startedAt = Date.now();

      // Retries only cover establishing the stream. Once tokens are flowing a
      // retry would duplicate output, so a mid-stream failure is terminal.
      const stream = await withResilience(
        (abortSignal) =>
          openai.chat.completions.create(
            {
              model,
              messages,
              stream: true,
              stream_options: { include_usage: true },
              ...(maxTokens ? { max_tokens: maxTokens } : {}),
              ...(temperature != null ? { temperature } : {}),
            },
            { signal: abortSignal },
          ),
        { model, timeoutMs, maxRetries, signal },
      );

      let content = "";
      let usage = null;
      let finishReason = null;

      try {
        for await (const chunk of stream) {
          if (chunk?.usage) usage = chunk.usage;
          const choice = chunk?.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          const text = choice?.delta?.content;
          if (text) {
            content += text;
            yield { type: "delta", text };
          }
        }
      } catch (err) {
        throw toAppError(err, { model, timeoutMs });
      }

      yield {
        type: "done",
        content,
        model,
        finishReason,
        usage: normalizeUsage(usage, {
          model,
          promptText: messages.map((m) => m.content).join("\n"),
          completionText: content,
        }),
        latencyMs: Date.now() - startedAt,
      };
    },

    /** Model ids the provider reports. Falls back to the configured allowlist. */
    async listModels({ signal } = {}) {
      try {
        const res = await withResilience(
          (abortSignal) => openai.models.list({ signal: abortSignal }),
          {
            model: "(list)",
            timeoutMs: config.MESH_TIMEOUT_MS,
            maxRetries: 0,
            signal,
          },
        );
        const ids = (res?.data ?? []).map((m) => m.id).filter(Boolean);
        return ids.length ? ids : config.allowedModels;
      } catch (err) {
        // Listing is a convenience, never a hard dependency.
        logger.warn({ err }, "model listing failed; using configured allowlist");
        return config.allowedModels;
      }
    },
  };
}
