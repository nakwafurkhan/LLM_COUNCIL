/**
 * Humanizer: draft, audit, revise.
 *
 * Three passes, all of them surfaced. The middle one — asking the model what
 * still reads as machine-written in its own draft — is what separates this
 * from a single "make it sound human" prompt, and hiding it would throw away
 * the most useful output of the run.
 *
 * Degradation, in the same spirit as Council: if the audit fails or returns
 * nothing parseable, the run continues with the draft as the final answer and
 * says so, rather than losing two completed passes to a failure in the third.
 */
import { HumanizerRun } from "../../models/HumanizerRun.js";
import { NotFoundError, UpstreamError } from "../../lib/errors.js";
import { sumUsage } from "../../lib/tokenCost.js";
import { auditOutputSchema } from "../../../../shared/schemas.js";
import { resolveModel } from "../llm/index.js";
import { detectPatterns, comparePatterns } from "./detector.js";
import { draftPrompt, auditPrompt, finalPrompt, cleanOutput } from "./prompts.js";

/**
 * Parse the audit response.
 *
 * Same defensive posture as the council chairman: JSON if we can get it,
 * otherwise salvage bullet points from prose, otherwise an empty list. An
 * unparseable audit is a missing opinion, not a failed run.
 */
export function parseAudit(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { notes: [], parsed: false };

  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const result = auditOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return { notes: result.data.notes, parsed: true };
    } catch {
      // Try the next shape.
    }
  }

  // Prose fallback: pull out anything that looks like a bullet or numbered item.
  const bullets = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 12 && !line.endsWith(":"));

  return { notes: bullets.slice(0, 6), parsed: false };
}

export function createHumanizerService({ config, llm }) {
  /**
   * Stream one pass, yielding `<name>-delta` events as tokens arrive.
   *
   * An async generator rather than a callback: a callback cannot yield from
   * inside the outer generator, and buffering each pass to completion before
   * emitting anything would defeat the point of streaming three of them.
   *
   * The completed text and usage land on `sink`, since a generator's return
   * value is awkward to reach through `yield*`.
   */
  async function* streamPass({ name, model, messages, maxTokens, signal, sink }) {
    let content = "";
    let usage = null;

    for await (const chunk of llm.streamModel({
      model,
      messages,
      maxTokens,
      timeoutMs: config.MESH_TIMEOUT_MS,
      signal,
    })) {
      if (chunk.type === "delta") {
        content += chunk.text;
        yield { type: `${name}-delta`, text: chunk.text };
      } else if (chunk.type === "done") {
        content = chunk.content || content;
        usage = chunk.usage;
      }
    }

    sink.content = content;
    sink.usage = usage;
  }

  /**
   * Run the pipeline, yielding progress.
   *
   * Events: start, draft-delta, draft, audit-delta, audit, final-delta,
   * complete.
   */
  async function* run({ text, voiceSample, tone = "neutral", model, signal, logger }) {
    const chosenModel = resolveModel(model, config.HUMANIZER_MODEL, config.allowedModels);
    const startedAt = Date.now();

    const before = detectPatterns(text);
    yield { type: "start", model: chosenModel, before };

    const usages = [];
    let partial = false;
    let partialReason = null;

    /* ---- pass 1: draft ---------------------------------------------- */

    const draftSink = {};
    let draft = "";
    try {
      yield* streamPass({
        name: "draft",
        model: chosenModel,
        messages: draftPrompt({ text, tone, voiceSample, findings: before.findings }),
        maxTokens: config.HUMANIZER_MAX_TOKENS,
        signal,
        sink: draftSink,
      });
      draft = cleanOutput(draftSink.content);
      if (draftSink.usage) usages.push(draftSink.usage);
    } catch (err) {
      // Nothing to degrade to: without a draft there is no run.
      throw new UpstreamError(`Humanizer draft pass failed: ${err.message}`, { cause: err });
    }

    if (!draft) throw new UpstreamError("The model returned an empty rewrite.");

    yield { type: "draft", text: draft };

    /* ---- pass 2: audit ---------------------------------------------- */

    const draftAnalysis = detectPatterns(draft);
    let notes = [];
    let auditRaw = "";

    const auditSink = {};
    try {
      yield* streamPass({
        name: "audit",
        model: chosenModel,
        messages: auditPrompt({ draft, findings: draftAnalysis.findings }),
        maxTokens: 1_024,
        signal,
        sink: auditSink,
      });
      auditRaw = auditSink.content ?? "";
      if (auditSink.usage) usages.push(auditSink.usage);

      const parsedAudit = parseAudit(auditRaw);
      notes = parsedAudit.notes;
      if (!parsedAudit.parsed) {
        logger?.warn("humanizer audit was not valid JSON; salvaged bullets from prose");
      }
    } catch (err) {
      // A failed audit costs us the third pass's guidance, not the whole run.
      logger?.warn({ err }, "humanizer audit pass failed; continuing with the draft");
      partial = true;
      partialReason = "The audit pass failed, so the final revision was skipped.";
    }

    yield { type: "audit", notes, raw: auditRaw };

    /* ---- pass 3: final ---------------------------------------------- */

    let final = draft;
    if (!partial) {
      const finalSink = {};
      try {
        yield* streamPass({
          name: "final",
          model: chosenModel,
          messages: finalPrompt({ draft, notes, tone, voiceSample }),
          maxTokens: config.HUMANIZER_MAX_TOKENS,
          signal,
          sink: finalSink,
        });
        const revised = cleanOutput(finalSink.content);
        if (revised) final = revised;
        else {
          partial = true;
          partialReason = "The revision pass returned nothing; showing the draft.";
        }
        if (finalSink.usage) usages.push(finalSink.usage);
      } catch (err) {
        logger?.warn({ err }, "humanizer revision pass failed; falling back to the draft");
        partial = true;
        partialReason = "The revision pass failed; showing the draft instead.";
      }
    }

    /* ---- persist ----------------------------------------------------- */

    const after = detectPatterns(final);
    const totals = sumUsage(usages);

    const doc = await HumanizerRun.create({
      original: text,
      draft,
      audit: { notes, raw: auditRaw },
      final,
      before,
      after,
      tone,
      // The sample itself is deliberately not stored: it is the user's own
      // writing and the run does not need it again.
      voiceSampleUsed: Boolean(voiceSample),
      model: chosenModel,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      costUsd: totals.costUsd,
      latencyMs: Date.now() - startedAt,
      partial,
      partialReason,
    });

    logger?.info(
      {
        runId: doc._id,
        before: before.total,
        after: after.total,
        notes: notes.length,
        costUsd: totals.costUsd,
      },
      "humanizer run complete",
    );

    yield { type: "complete", run: doc, diff: comparePatterns(before, after) };
  }

  /** Non-streaming path, for scripts and tests. */
  async function runToCompletion(options) {
    let final = null;
    for await (const event of run(options)) {
      if (event.type === "complete") final = event;
    }
    return final;
  }

  async function getRun(id) {
    const doc = await HumanizerRun.findById(id);
    if (!doc) throw new NotFoundError(`Humanizer run ${id} not found`);
    return doc;
  }

  async function listRuns({ limit = 20 } = {}) {
    return HumanizerRun.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-original -draft -final -audit.raw")
      .lean();
  }

  return { run, runToCompletion, getRun, listRuns, parseAudit };
}
