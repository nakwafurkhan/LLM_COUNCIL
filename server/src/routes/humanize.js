/**
 * Humanizer endpoints.
 *
 * Streams by default. Three sequential model passes over a long document is a
 * slow operation, and watching the draft appear is the difference between
 * "working" and "hung".
 */
import { Router } from "express";
import { z } from "zod";

import {
  humanizeRequestSchema,
  humanizeHistoryQuerySchema,
  objectIdSchema,
} from "../../../shared/schemas.js";
import { validate, validateAll } from "../middleware/validate.js";
import { createSseStream } from "../lib/sse.js";
import { createHumanizerService } from "../services/humanizer/index.js";
import { comparePatterns } from "../services/humanizer/detector.js";
import { isAppError } from "../lib/errors.js";

const idParams = z.object({ id: objectIdSchema });

export function humanizeRouter({ config, llm, logger, limiters }) {
  const router = Router();
  const service = createHumanizerService({ config, llm });

  const toDto = (run, diff) => ({
    id: String(run._id ?? run.id),
    original: run.original,
    draft: run.draft,
    audit: { notes: run.audit?.notes ?? [] },
    final: run.final,
    before: run.before,
    after: run.after,
    diff: diff ?? comparePatterns(run.before, run.after),
    tone: run.tone,
    voiceSampleUsed: run.voiceSampleUsed,
    partial: run.partial,
    partialReason: run.partialReason,
    model: run.model,
    usage: {
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      costUsd: run.costUsd,
    },
    latencyMs: run.latencyMs,
    createdAt: run.createdAt,
  });

  router.post(
    "/humanize",
    // Three passes per request, so it shares the council bucket rather than
    // the general one.
    limiters.council,
    validate(humanizeRequestSchema),
    async (req, res, next) => {
      const { text, voiceSample, tone, model, stream } = req.body;

      if (!stream) {
        try {
          const result = await service.runToCompletion({
            text,
            voiceSample,
            tone,
            model,
            logger: req.log,
          });
          return res.status(201).json(toDto(result.run, result.diff));
        } catch (err) {
          return next(err);
        }
      }

      const abort = new AbortController();
      const sse = createSseStream(req, res);
      sse.onAbort(() => abort.abort());

      try {
        for await (const event of service.run({
          text,
          voiceSample,
          tone,
          model,
          signal: abort.signal,
          logger: req.log,
        })) {
          switch (event.type) {
            case "start":
              sse.send("start", { model: event.model, before: event.before });
              break;
            case "draft-delta":
            case "audit-delta":
            case "final-delta":
              sse.send(event.type, { text: event.text });
              break;
            case "draft":
              sse.send("draft", { text: event.text });
              break;
            case "audit":
              // The point of the middle pass: what the model thinks is still
              // wrong with its own rewrite.
              sse.send("audit", { notes: event.notes });
              break;
            case "complete":
              sse.send("complete", toDto(event.run, event.diff));
              break;
            default:
              break;
          }
          if (sse.aborted) break;
        }
        sse.done({ ok: true });
      } catch (err) {
        req.log?.error({ err }, "humanizer run failed");
        sse.fail({
          code: isAppError(err) ? err.code : "INTERNAL_ERROR",
          message: isAppError(err) && err.expose ? err.message : "The humanizer run failed.",
        });
      }
    },
  );

  router.get(
    "/humanize",
    validate(humanizeHistoryQuerySchema, "query"),
    async (req, res, next) => {
      try {
        const runs = await service.listRuns(req.validatedQuery);
        res.json({
          items: runs.map((r) => ({
            id: String(r._id),
            tone: r.tone,
            model: r.model,
            before: r.before?.total ?? 0,
            after: r.after?.total ?? 0,
            noteCount: r.audit?.notes?.length ?? 0,
            partial: r.partial,
            costUsd: r.costUsd,
            createdAt: r.createdAt,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/humanize/:id", validateAll({ params: idParams }), async (req, res, next) => {
    try {
      res.json(toDto(await service.getRun(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  logger?.debug("humanizer router mounted");
  return router;
}
