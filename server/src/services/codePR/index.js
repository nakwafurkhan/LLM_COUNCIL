/**
 * The Code+PR pipeline.
 *
 *   queued -> planning -> generating -> verifying -> awaiting_approval
 *          -> (human approves) -> pushing -> completed
 *
 * Design decision, recorded here and in the README: jobs run on an in-process
 * queue with the job record in Mongo as the durable state, not BullMQ + Redis.
 * A Redis dependency buys durable retries across process restarts; the same
 * safety is achieved here by reconciling interrupted jobs at boot and by the
 * fact that nothing is pushed without a human approval step anyway. When this
 * needs to scale to multiple server processes, that is the point to revisit it.
 *
 * Every stage writes to the job before and after, so a crash leaves a job that
 * says what it was doing rather than a job stuck at "queued" forever.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { PrJob, ACTIVE_STATUSES } from "../../models/PrJob.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { logger as defaultLogger } from "../../lib/logger.js";
import { resolveModel } from "../llm/index.js";
import { assertInsideRepo, assertValidBranchName, branchNameFromTask } from "./paths.js";
import * as gitOps from "./git.js";
import { buildContextPack } from "./context.js";
import { createPlanner } from "./planner.js";
import { verify, buildRepairContext } from "./verify.js";
import { createGithubClient, buildPrBody, prTitleFromTask } from "./github.js";

export function createCodePrService({
  config,
  llm,
  logger = defaultLogger,
  github,
  git = gitOps,
}) {
  const planner = createPlanner({ config, llm });
  const gh = github ?? createGithubClient({ config });

  /** Jobs currently executing in this process, by id. */
  const running = new Map();
  /** Subscribers to job progress, for SSE. */
  const listeners = new Map();

  function emit(jobId, event) {
    for (const fn of listeners.get(String(jobId)) ?? []) {
      try {
        fn(event);
      } catch {
        /* a listener must never break the pipeline */
      }
    }
  }

  function subscribe(jobId, fn) {
    const key = String(jobId);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  }

  async function transition(job, status, note) {
    await job.transition(status, note);
    logger.info({ jobId: job._id, status, note }, "pr job transition");
    emit(job._id, { status, note });
  }

  function requireRepo() {
    if (!config.REPO_LOCAL_PATH) {
      throw new ValidationError(
        "REPO_LOCAL_PATH is not configured; Code+PR mode is unavailable",
        [{ path: "REPO_LOCAL_PATH", message: "must be set to a local clone" }],
      );
    }
    return path.resolve(config.REPO_LOCAL_PATH);
  }

  /* ------------------------------------------------------------------ */
  /* Job creation                                                        */
  /* ------------------------------------------------------------------ */

  async function createJob({
    task,
    targetPaths = [],
    branch,
    baseBranch,
    model,
    idempotencyKey,
  }) {
    const repoRoot = requireRepo();

    // A repeated key returns the original job rather than opening a second PR
    // for the same work — the failure mode this prevents is a retrying client
    // creating five duplicate pull requests.
    if (idempotencyKey) {
      const existing = await PrJob.findOne({ idempotencyKey });
      if (existing) return { job: existing, reused: true };
    }

    for (const target of targetPaths) assertInsideRepo(repoRoot, target);

    const branchName = branch ? assertValidBranchName(branch) : branchNameFromTask(task);
    const base = assertValidBranchName(baseBranch ?? config.BASE_BRANCH);

    // One active job per branch: two jobs sharing a worktree branch would
    // interleave commits and produce a nonsense diff.
    const active = await PrJob.findOne({
      branch: branchName,
      status: { $in: ACTIVE_STATUSES },
    });
    if (active) {
      throw new ConflictError(
        `Branch ${branchName} already has an active job (${active._id}, ${active.status})`,
      );
    }

    const job = await PrJob.create({
      task,
      targetPaths,
      branch: branchName,
      baseBranch: base,
      model: resolveModel(model, config.CODE_MODEL, config.allowedModels),
      status: "queued",
      idempotencyKey: idempotencyKey ?? null,
      timeline: [{ status: "queued", at: new Date(), note: "job accepted" }],
    });

    return { job, reused: false };
  }

  /* ------------------------------------------------------------------ */
  /* The pipeline                                                        */
  /* ------------------------------------------------------------------ */

  async function runJob(jobId) {
    const job = await PrJob.findById(jobId);
    if (!job) throw new NotFoundError(`PR job ${jobId} not found`);

    const repoRoot = requireRepo();
    let worktree = null;

    try {
      /* ---- plan ---------------------------------------------------- */
      await transition(job, "planning", "building context pack");

      worktree = await git.createWorktree({
        repoPath: repoRoot,
        branch: job.branch,
        baseBranch: job.baseBranch,
        jobId: String(job._id),
      });

      const contextPack = await buildContextPack(worktree.dir, {
        task: job.task,
        targetPaths: job.targetPaths,
        tokenBudget: config.PR_CONTEXT_TOKEN_BUDGET,
      });

      const plan = await planner.plan({
        task: job.task,
        targetPaths: job.targetPaths,
        contextPack,
        model: job.model,
        repoRoot: worktree.dir,
      });

      job.plan = plan;
      await job.save();
      await transition(job, "generating", `${plan.files.length} file(s) planned`);

      /* ---- generate ------------------------------------------------ */
      const applied = await applyPlan({ job, plan, worktree, contextPack });

      /* ---- verify -------------------------------------------------- */
      await transition(job, "verifying", "running lint and tests");
      let result = await verify({ cwd: worktree.dir, config });
      let repairs = 0;

      while (!result.ok && repairs < config.PR_MAX_REPAIR_ATTEMPTS) {
        repairs += 1;
        await transition(job, "verifying", `verification failed; repair attempt ${repairs}`);

        await applyPlan({
          job,
          plan,
          worktree,
          contextPack,
          repairContext: buildRepairContext(result),
        });

        result = await verify({ cwd: worktree.dir, config });
      }

      job.verification = { lint: result.lint, tests: result.tests, repairAttempts: repairs };
      await job.save();

      if (!result.ok) {
        // Do not push broken code. The logs are on the job so the failure is
        // diagnosable without re-running anything.
        job.error = "Verification failed after the maximum number of repair attempts.";
        await job.save();
        await transition(job, "failed", "lint or tests still failing; nothing was pushed");
        await worktree.cleanup({ deleteBranch: true });
        return job;
      }

      /* ---- diff ---------------------------------------------------- */
      await git.stageAll(worktree.dir);
      for (const file of job.files) {
        file.diff = await git.diffFile(worktree.dir, file.path);
      }
      job.markModified("files");
      await job.save();

      logger.info({ jobId: job._id, files: applied.length }, "job ready for review");

      /* ---- gate ---------------------------------------------------- */
      if (config.PR_AUTO_APPROVE) {
        // Escape hatch for CI only; the default is a human.
        await transition(job, "awaiting_approval", "auto-approve enabled");
        return approve(job._id, { worktree });
      }

      await transition(
        job,
        "awaiting_approval",
        "review the diff, then POST /api/pr/:id/approve",
      );
      return job;
    } catch (err) {
      logger.error({ err, jobId }, "pr job failed");
      job.error = err instanceof AppError ? err.message : "The job failed unexpectedly.";
      await job.save().catch(() => {});
      await transition(job, "failed", job.error).catch(() => {});
      await worktree?.cleanup({ deleteBranch: true }).catch(() => {});
      throw err;
    } finally {
      running.delete(String(jobId));
    }
  }

  /** Write every planned file into the worktree. */
  async function applyPlan({ job, plan, worktree, contextPack, repairContext }) {
    const changes = [];

    for (const file of plan.files) {
      const abs = assertInsideRepo(worktree.dir, file.path);

      if (file.action === "delete") {
        const before = await safeRead(abs);
        await fs.rm(abs, { force: true });
        changes.push({ path: file.path, action: "delete", before, after: null, diff: "" });
        continue;
      }

      const before = await safeRead(abs);
      const after = await planner.generateFile({
        task: job.task,
        plan,
        file,
        repoRoot: worktree.dir,
        contextPack,
        model: job.model,
        repairContext,
      });

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, after, "utf8");
      changes.push({ path: file.path, action: file.action, before, after, diff: "" });
    }

    job.files = changes;
    job.markModified("files");
    await job.save();
    return changes;
  }

  /* ------------------------------------------------------------------ */
  /* Approval                                                            */
  /* ------------------------------------------------------------------ */

  async function approve(jobId, { worktree } = {}) {
    const job = await PrJob.findById(jobId);
    if (!job) throw new NotFoundError(`PR job ${jobId} not found`);
    if (job.status !== "awaiting_approval") {
      throw new ConflictError(
        `Job ${jobId} is ${job.status}; only a job awaiting approval can be approved`,
      );
    }

    const repoRoot = requireRepo();
    const dir = worktree?.dir ?? (await worktreeDirFor(job));

    try {
      await transition(job, "pushing", "committing and pushing");

      await git.stageAll(dir);
      const sha = await git.commit(dir, commitMessageFor(job));
      job.commitSha = sha;
      await job.save();

      await git.pushBranch({
        cwd: dir,
        branch: job.branch,
        token: config.GITHUB_TOKEN,
      });

      const { url, number } = await gh.createPullRequest({
        title: prTitleFromTask(job.task),
        body: buildPrBody(job),
        head: job.branch,
        base: job.baseBranch,
      });

      job.prUrl = url;
      job.prNumber = number;
      await job.save();
      await transition(job, "completed", `opened ${url}`);
      return job;
    } catch (err) {
      job.error = err instanceof AppError ? err.message : "Push or PR creation failed.";
      await job.save();
      await transition(job, "failed", job.error);
      throw err;
    } finally {
      await cleanupWorktree(repoRoot, job, { deleteBranch: false });
    }
  }

  async function reject(jobId) {
    const job = await PrJob.findById(jobId);
    if (!job) throw new NotFoundError(`PR job ${jobId} not found`);
    if (!["awaiting_approval", "failed"].includes(job.status)) {
      throw new ConflictError(`Job ${jobId} is ${job.status} and cannot be rejected`);
    }

    const repoRoot = requireRepo();
    await cleanupWorktree(repoRoot, job, { deleteBranch: true });
    await transition(job, "cancelled", "rejected; worktree and branch discarded");
    return job;
  }

  async function cleanupWorktree(repoRoot, job, { deleteBranch }) {
    const { tmpdir } = await import("node:os");
    const dir = path.join(tmpdir(), `${gitOps.WORKTREE_PREFIX}${job._id}`);
    try {
      await git.git(["worktree", "remove", "--force", dir], { cwd: repoRoot });
    } catch {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await git.git(["worktree", "prune"], { cwd: repoRoot }).catch(() => {});
    if (deleteBranch) {
      await git.git(["branch", "-D", job.branch], { cwd: repoRoot }).catch(() => {});
    }
  }

  async function worktreeDirFor(job) {
    const { tmpdir } = await import("node:os");
    return path.join(tmpdir(), `${gitOps.WORKTREE_PREFIX}${job._id}`);
  }

  function commitMessageFor(job) {
    const title = prTitleFromTask(job.task, { max: 68 });
    return `${title}\n\n${job.plan?.summary ?? ""}\n\nGenerated by LLM Council Code+PR using ${job.model}.`;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Start a job in the background and return immediately. */
  function enqueue(jobId) {
    const key = String(jobId);
    if (running.has(key)) return running.get(key);
    const promise = runJob(jobId).catch(() => {
      // Already recorded on the job; an unhandled rejection here would take
      // the process down for a failure that is expected and stored.
    });
    running.set(key, promise);
    return promise;
  }

  /**
   * Boot reconciliation.
   *
   * A process killed mid-job leaves a worktree on disk and a job frozen in a
   * transient state. Neither self-heals, and the stale worktree blocks the
   * next job on that branch.
   */
  async function recoverInterruptedJobs() {
    if (!config.REPO_LOCAL_PATH) return { recovered: [], worktrees: [] };
    const repoRoot = path.resolve(config.REPO_LOCAL_PATH);

    const interrupted = await PrJob.find({
      status: { $in: ["planning", "generating", "verifying", "pushing"] },
    });

    for (const job of interrupted) {
      job.error = "Interrupted by a server restart.";
      await job.save();
      await job.transition("failed", "interrupted by a server restart");
    }

    // Jobs still legitimately awaiting a human keep their worktrees.
    const keep = await PrJob.find({ status: "awaiting_approval" }).select("_id");
    const worktrees = await git.pruneStaleWorktrees(
      repoRoot,
      keep.map((j) => String(j._id)),
    );

    if (interrupted.length || worktrees.length) {
      logger.warn(
        { jobs: interrupted.length, worktrees: worktrees.length },
        "recovered interrupted PR jobs at boot",
      );
    }

    return { recovered: interrupted.map((j) => String(j._id)), worktrees };
  }

  async function getJob(id) {
    const job = await PrJob.findById(id);
    if (!job) throw new NotFoundError(`PR job ${id} not found`);
    return job;
  }

  async function listJobs({ limit = 20 } = {}) {
    return PrJob.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-files.before -files.after")
      .lean();
  }

  return {
    createJob,
    runJob,
    enqueue,
    approve,
    reject,
    getJob,
    listJobs,
    subscribe,
    recoverInterruptedJobs,
  };
}

async function safeRead(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}
