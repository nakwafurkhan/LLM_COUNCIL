/**
 * Code+PR endpoints.
 *
 * `POST /api/pr` returns 202 immediately. Blocking an HTTP request on a
 * multi-step git + LLM pipeline is how you get gateway timeouts on the slow
 * path and no progress visibility on any path.
 */
import { Router } from "express";
import { z } from "zod";

import { createPrJobSchema, objectIdSchema } from "../../../shared/schemas.js";
import { validate, validateAll } from "../middleware/validate.js";
import { createSseStream } from "../lib/sse.js";
import { createCodePrService } from "../services/codePR/index.js";

const idParams = z.object({ id: objectIdSchema });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export function prRouter({ config, llm, logger, limiters, codePr }) {
  const router = Router();
  const service = codePr ?? createCodePrService({ config, llm, logger });

  const toDto = (job) => ({
    id: String(job._id ?? job.id),
    task: job.task,
    targetPaths: job.targetPaths,
    branch: job.branch,
    baseBranch: job.baseBranch,
    model: job.model,
    status: job.status,
    plan: job.plan ?? null,
    files: (job.files ?? []).map((f) => ({
      path: f.path,
      action: f.action,
      diff: f.diff,
      before: f.before,
      after: f.after,
    })),
    verification: job.verification ?? null,
    prUrl: job.prUrl ?? null,
    prNumber: job.prNumber ?? null,
    commitSha: job.commitSha ?? null,
    error: job.error ?? null,
    timeline: job.timeline ?? [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  router.post("/pr", limiters.pr, validate(createPrJobSchema), async (req, res, next) => {
    try {
      const idempotencyKey = req.get("idempotency-key") || undefined;
      const { job, reused } = await service.createJob({ ...req.body, idempotencyKey });

      if (!reused) service.enqueue(job._id);

      // 202: accepted, not finished. The client polls or streams from here.
      res.status(202).json({ jobId: String(job._id), status: job.status, reused });
    } catch (err) {
      next(err);
    }
  });

  router.get("/pr", validate(listQuery, "query"), async (req, res, next) => {
    try {
      const jobs = await service.listJobs(req.validatedQuery);
      res.json({
        items: jobs.map((j) => ({
          id: String(j._id),
          task: j.task,
          branch: j.branch,
          status: j.status,
          prUrl: j.prUrl ?? null,
          createdAt: j.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/pr/:id", validate(idParams, "params"), async (req, res, next) => {
    try {
      res.json(toDto(await service.getJob(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  /** Live progress for a running job. */
  router.get("/pr/:id/stream", validate(idParams, "params"), async (req, res, next) => {
    let job;
    try {
      job = await service.getJob(req.params.id);
    } catch (err) {
      return next(err);
    }

    const sse = createSseStream(req, res);
    sse.send("status", { status: job.status, note: "current state" });

    const unsubscribe = service.subscribe(job._id, (event) => {
      sse.send("status", event);
      // Terminal states end the stream; leaving it open would hold a socket
      // open forever for a job that will never change again.
      if (["completed", "failed", "cancelled", "awaiting_approval"].includes(event.status)) {
        sse.done({ status: event.status });
      }
    });

    sse.onAbort(unsubscribe);

    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(job.status)) {
      unsubscribe();
      sse.done({ status: job.status });
    }
  });

  router.post(
    "/pr/:id/approve",
    limiters.pr,
    validateAll({ params: idParams }),
    async (req, res, next) => {
      try {
        const job = await service.approve(req.params.id);
        res.json(toDto(job));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/pr/:id/reject", validateAll({ params: idParams }), async (req, res, next) => {
    try {
      res.json(toDto(await service.reject(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  logger?.debug("pr router mounted");
  return router;
}
