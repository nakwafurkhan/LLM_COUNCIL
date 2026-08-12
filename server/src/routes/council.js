/**
 * Council endpoints.
 *
 * Streams by default: member cards land as they arrive and the chairman panel
 * streams last, which is what removes the "why is this so slow" problem even
 * though the wall-clock is unchanged.
 */
import { Router } from "express";
import { z } from "zod";

import { councilRequestSchema, objectIdSchema } from "../../../shared/schemas.js";
import { validate, validateAll } from "../middleware/validate.js";
import { createSseStream } from "../lib/sse.js";
import { createCouncilService } from "../services/council.js";
import { isAppError } from "../lib/errors.js";

const idParams = z.object({ id: objectIdSchema });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export function councilRouter({ config, llm, logger, limiters }) {
  const router = Router();
  const service = createCouncilService({ config, llm });

  const toDto = (run, { cached = false } = {}) => ({
    id: String(run._id ?? run.id),
    prompt: run.prompt,
    models: run.models,
    chairmanModel: run.chairmanModel,
    memberAnswers: (run.memberAnswers ?? []).map((m) => ({
      model: m.model,
      status: m.status,
      content: m.content,
      error: m.error,
      latencyMs: m.latencyMs,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      costUsd: m.costUsd,
    })),
    finalAnswer: run.finalAnswer,
    disagreements: run.disagreements ?? [],
    confidence: run.confidence,
    confidenceNote: run.confidenceNote,
    partial: run.partial,
    partialReason: run.partialReason,
    totals: {
      promptTokens: run.totalPromptTokens,
      completionTokens: run.totalCompletionTokens,
      costUsd: run.totalCostUsd,
      latencyMs: run.totalLatencyMs,
    },
    cached,
    createdAt: run.createdAt,
  });

  router.post(
    "/council",
    limiters.council,
    validate(councilRequestSchema),
    async (req, res, next) => {
      const { prompt, models, chairmanModel, stream, bypassCache } = req.body;

      if (!stream) {
        try {
          const result = await service.runToCompletion({
            prompt,
            models,
            chairmanModel,
            bypassCache,
            logger: req.log,
          });
          return res.status(201).json(toDto(result.run, { cached: result.cached }));
        } catch (err) {
          return next(err);
        }
      }

      const sse = createSseStream(req, res);

      try {
        for await (const event of service.run({
          prompt,
          models,
          chairmanModel,
          bypassCache,
          logger: req.log,
        })) {
          switch (event.type) {
            case "start":
              sse.send("start", { models: event.models, chairmanModel: event.chairmanModel });
              break;
            case "member":
              // The whole point of streaming: a card appears the moment its
              // model answers, including when that answer is a failure.
              sse.send("member", { answer: event.answer });
              break;
            case "chairman-start":
              sse.send("chairman-start", { model: event.model });
              break;
            case "chairman-delta":
              sse.send("chairman-delta", { text: event.text });
              break;
            case "complete":
              sse.send("complete", toDto(event.run, { cached: event.cached }));
              break;
            default:
              break;
          }
          if (sse.aborted) break;
        }
        sse.done({ ok: true });
      } catch (err) {
        req.log?.error({ err }, "council run failed");
        sse.fail({
          code: isAppError(err) ? err.code : "INTERNAL_ERROR",
          message: isAppError(err) && err.expose ? err.message : "The council run failed.",
        });
      }
    },
  );

  router.get("/council", validate(listQuery, "query"), async (req, res, next) => {
    try {
      const runs = await service.listRuns(req.validatedQuery);
      res.json({
        items: runs.map((r) => ({
          id: String(r._id),
          prompt: r.prompt,
          models: r.models,
          partial: r.partial,
          confidence: r.confidence,
          totals: { costUsd: r.totalCostUsd, latencyMs: r.totalLatencyMs },
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/council/:id", validateAll({ params: idParams }), async (req, res, next) => {
    try {
      res.json(toDto(await service.getRun(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  logger?.debug("council router mounted");
  return router;
}
