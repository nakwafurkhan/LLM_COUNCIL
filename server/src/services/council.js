/**
 * Council mode.
 *
 * Ask several models the same question, then have a chairman synthesise.
 * The naive version of this is a `Promise.all` over the member list, which
 * fails in three ways this implementation is built to avoid:
 *
 *  1. One hanging model holds the entire run hostage  -> per-member timeout.
 *  2. One failing model fails the whole run           -> allSettled + degrade.
 *  3. The user stares at a spinner for 40 seconds     -> progressive streaming.
 *
 * The run is an async generator so the route can forward member cards to the
 * client as each lands, rather than buffering until the chairman finishes.
 */
import { createHash } from "node:crypto";

import { CouncilRun } from "../models/CouncilRun.js";
import { UpstreamError, NotFoundError } from "../lib/errors.js";
import { sumUsage } from "../lib/tokenCost.js";
import { chairmanOutputSchema } from "../../../shared/schemas.js";
import { resolveModel } from "./llm/index.js";

/* -------------------------------------------------------------------- */
/* Pure helpers — unit tested directly                                   */
/* -------------------------------------------------------------------- */

/**
 * Cache key for a run.
 *
 * Normalises whitespace and case so trivially different prompts hit the same
 * entry, and sorts the model set so member order never affects the key.
 */
export function hashRun({ prompt, models, chairmanModel }) {
  const normalized = String(prompt).trim().replace(/\s+/g, " ").toLowerCase();
  const payload = JSON.stringify({
    prompt: normalized,
    models: [...models].sort(),
    chairmanModel,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Run tasks with a concurrency ceiling.
 *
 * A council of eight models against a rate-limited router will 429 half its
 * members without this.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Parse the chairman's structured reply.
 *
 * Models return JSON in fences, with prose preambles, or not at all. Rather
 * than failing a run that produced a perfectly good answer, fall back to
 * treating the whole response as the answer with no disagreements — and say
 * so via `parsed: false` so the caller knows what it has.
 */
export function parseChairmanOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return {
      parsed: false,
      answer: "",
      disagreements: [],
      confidence: "low",
      confidenceNote: "",
    };
  }

  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const result = chairmanOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return { parsed: true, ...result.data };
    } catch {
      // Try the next candidate shape.
    }
  }

  return {
    parsed: false,
    answer: text,
    disagreements: [],
    confidence: "medium",
    confidenceNote: "Chairman response was not structured; showing it verbatim.",
  };
}

const CHAIRMAN_SYSTEM = `You are the chairman of a council of AI models. You are given the same question that was put to several members, and each member's answer.

Synthesise a single best answer. Where members genuinely disagree, name the disagreement rather than papering over it — a suppressed disagreement is worse than no council at all.

Respond with ONLY a JSON object, no prose outside it, in exactly this shape:
{
  "answer": "the synthesised answer",
  "disagreements": [
    { "claim": "what is disputed", "positions": [ { "model": "model id", "stance": "what it argued" } ] }
  ],
  "confidence": "low" | "medium" | "high",
  "confidenceNote": "one sentence on why"
}

Set confidence to "low" when members conflict on substance or when few answered.`;

/** Build the chairman transcript. Failed members are deliberately excluded. */
export function buildChairmanPrompt(prompt, memberAnswers) {
  const successful = memberAnswers.filter((m) => m.status === "fulfilled");
  const body = successful
    .map((m, i) => `### Member ${i + 1} — ${m.model}\n${m.content}`)
    .join("\n\n");

  return [
    { role: "system", content: CHAIRMAN_SYSTEM },
    {
      role: "user",
      content: `## Question\n${prompt}\n\n## Member answers\n${body}`,
    },
  ];
}

/* -------------------------------------------------------------------- */
/* Service                                                               */
/* -------------------------------------------------------------------- */

export function createCouncilService({ config, llm }) {
  /** Ask one member, converting any failure into a recorded result. */
  async function askMember(model, prompt) {
    const startedAt = Date.now();
    try {
      const result = await llm.askModel({
        model,
        messages: [
          {
            role: "system",
            content:
              "Answer the question directly and independently. You are one member of a " +
              "council; do not hedge by deferring to other models.",
          },
          { role: "user", content: prompt },
        ],
        maxTokens: config.CHAT_MAX_TOKENS,
        timeoutMs: config.COUNCIL_MEMBER_TIMEOUT_MS,
      });

      return {
        model,
        status: "fulfilled",
        content: result.content,
        error: null,
        latencyMs: result.latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: result.usage.costUsd,
      };
    } catch (err) {
      // A member's failure is data about the run, not an exception to bubble.
      return {
        model,
        status: err?.code === "TIMEOUT" ? "timeout" : "rejected",
        content: "",
        error: err?.message ?? "unknown error",
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      };
    }
  }

  async function findCached(promptHash) {
    if (config.COUNCIL_CACHE_TTL_MS <= 0) return null;
    const cutoff = new Date(Date.now() - config.COUNCIL_CACHE_TTL_MS);
    return CouncilRun.findOne({ promptHash, createdAt: { $gte: cutoff } }).sort({
      createdAt: -1,
    });
  }

  /**
   * Execute a run, yielding progress.
   *
   * Events: `{type:"start"}`, `{type:"member"}` per member as it lands,
   * `{type:"chairman-start"}`, `{type:"chairman-delta"}`, and finally
   * `{type:"complete", run}`.
   */
  async function* run({ prompt, models, chairmanModel, bypassCache = false, logger }) {
    const memberModels = (models ?? config.COUNCIL_MODELS).map((m) =>
      resolveModel(m, m, config.allowedModels),
    );
    const chairman = resolveModel(chairmanModel, config.CHAIRMAN_MODEL, config.allowedModels);

    const promptHash = hashRun({ prompt, models: memberModels, chairmanModel: chairman });
    const startedAt = Date.now();

    if (!bypassCache) {
      const cached = await findCached(promptHash);
      if (cached) {
        yield { type: "complete", run: cached, cached: true };
        return;
      }
    }

    yield { type: "start", models: memberModels, chairmanModel: chairman };

    /* ---- fan out ---------------------------------------------------- */

    const answers = new Array(memberModels.length);
    const pending = [];

    // Bounded concurrency, but each answer is surfaced the moment it lands.
    // A queue rather than `await mapWithConcurrency` directly, because the
    // generator has to yield from the outer scope.
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(config.COUNCIL_MAX_CONCURRENCY, memberModels.length) },
      async function worker() {
        while (cursor < memberModels.length) {
          const index = cursor++;
          const answer = await askMember(memberModels[index], prompt);
          answers[index] = answer;
          pending.push(answer);
        }
      },
    ).map((p) => p);

    const fanOut = Promise.all(workers);

    // Drain `pending` as results appear so member cards stream out.
    let settled = false;
    fanOut.then(
      () => (settled = true),
      () => (settled = true),
    );

    while (!settled || pending.length) {
      if (pending.length) {
        yield { type: "member", answer: pending.shift() };
      } else {
        // Yield to the event loop rather than spinning.
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    await fanOut;

    const memberAnswers = answers.filter(Boolean);
    const successful = memberAnswers.filter((m) => m.status === "fulfilled");
    const failed = memberAnswers.filter((m) => m.status !== "fulfilled");

    // Degrade, don't fail: one surviving member is still a usable answer.
    // Only a total wipeout is a 502.
    if (successful.length === 0) {
      throw new UpstreamError(
        `Every council member failed (${memberAnswers.map((m) => m.model).join(", ")})`,
        {
          details: { members: memberAnswers.map((m) => ({ model: m.model, error: m.error })) },
        },
      );
    }

    /* ---- chairman --------------------------------------------------- */

    yield { type: "chairman-start", model: chairman };

    const chairmanMessages = buildChairmanPrompt(prompt, memberAnswers);
    let chairmanText = "";
    let chairmanUsage = null;
    let chairmanLatency = 0;

    try {
      for await (const chunk of llm.streamModel({
        model: chairman,
        messages: chairmanMessages,
        maxTokens: config.CHAT_MAX_TOKENS,
        timeoutMs: config.MESH_TIMEOUT_MS,
      })) {
        if (chunk.type === "delta") {
          chairmanText += chunk.text;
          yield { type: "chairman-delta", text: chunk.text };
        } else if (chunk.type === "done") {
          chairmanText = chunk.content || chairmanText;
          chairmanUsage = chunk.usage;
          chairmanLatency = chunk.latencyMs;
        }
      }
    } catch (err) {
      logger?.error({ err, model: chairman }, "chairman failed");
      throw new UpstreamError(`Chairman model ${chairman} failed: ${err.message}`, {
        cause: err,
      });
    }

    const parsed = parseChairmanOutput(chairmanText);
    if (!parsed.parsed) {
      logger?.warn({ model: chairman }, "chairman output was not valid JSON; using raw text");
    }

    /* ---- persist ---------------------------------------------------- */

    const totals = sumUsage([...memberAnswers, ...(chairmanUsage ? [chairmanUsage] : [])]);

    const doc = await CouncilRun.create({
      prompt,
      promptHash,
      models: memberModels,
      memberAnswers,
      chairmanModel: chairman,
      finalAnswer: parsed.answer,
      disagreements: parsed.disagreements,
      confidence: parsed.confidence,
      confidenceNote: parsed.confidenceNote,
      partial: failed.length > 0,
      partialReason: failed.length
        ? `${failed.length} of ${memberAnswers.length} members did not answer: ${failed
            .map((f) => `${f.model} (${f.status})`)
            .join(", ")}`
        : null,
      totalPromptTokens: totals.promptTokens,
      totalCompletionTokens: totals.completionTokens,
      totalCostUsd: totals.costUsd,
      totalLatencyMs: Date.now() - startedAt,
    });

    logger?.info(
      {
        runId: doc._id,
        members: memberAnswers.length,
        failed: failed.length,
        costUsd: totals.costUsd,
        chairmanLatency,
      },
      "council run complete",
    );

    yield { type: "complete", run: doc, cached: false };
  }

  /** Collect a run without streaming. Used by the non-SSE path and by tests. */
  async function runToCompletion(options) {
    let final = null;
    for await (const event of run(options)) {
      if (event.type === "complete") final = event;
    }
    return final;
  }

  async function getRun(id) {
    const doc = await CouncilRun.findById(id);
    if (!doc) throw new NotFoundError(`Council run ${id} not found`);
    return doc;
  }

  async function listRuns({ limit = 20 } = {}) {
    return CouncilRun.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-memberAnswers.content")
      .lean();
  }

  return { run, runToCompletion, getRun, listRuns, hashRun, askMember };
}
