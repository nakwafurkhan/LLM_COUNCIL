/**
 * Code+PR against a real local git repository.
 *
 * A throwaway repo with a bare origin on disk stands in for GitHub, so pushes
 * are genuine pushes and the assertions about what did or did not reach the
 * remote mean something. Octokit is stubbed; nothing touches the network.
 *
 * The four limitations from the brief are each covered here:
 *   1. multi-file coordinated edits
 *   2. codebase awareness (the model receives real repo contents)
 *   3. verification before commit
 *   4. diff review before push
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadConfig } from "../../src/config/env.js";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/lib/logger.js";
import { createCodePrService } from "../../src/services/codePR/index.js";
import { createFakeLlm } from "../fixtures/fakeLlm.js";
import { createFixtureRepo, createOctokitStub } from "../fixtures/fixtureRepo.js";
import { TEST_ENV } from "../fixtures/testApp.js";
import { PrJob } from "../../src/models/PrJob.js";
import { WORKTREE_PREFIX } from "../../src/services/codePR/git.js";

let repo;
let app;
let llm;
let octokit;
let service;
let pending;

/** A plan touching two files, which the old single-file flow could not do. */
const twoFilePlan = {
  summary: "Add a farewell helper and cover it with a test.",
  files: [
    { path: "src/index.js", action: "modify", reason: "add the farewell export" },
    { path: "src/farewell.test.js", action: "create", reason: "cover the new helper" },
  ],
  notes: "Keep ESM syntax.",
};

/**
 * Script the model: a plan first, then file contents for each generate call.
 * The fake replies based on what the prompt asks for, which keeps the test
 * from depending on call ordering.
 */
function scriptModel(plan = twoFilePlan) {
  llm.script("openai/gpt-4o", {
    content: (messages) => {
      const prompt = messages.map((m) => m.content).join("\n");
      if (prompt.includes("planning a code change")) return JSON.stringify(plan);
      // Match the generator's final instruction, not any mention of the path:
      // the prompt also lists sibling files, so a loose match returns the
      // wrong file's contents.
      const target = /Now write the complete new contents of (\S+)/.exec(prompt)?.[1];
      if (target === "src/farewell.test.js") {
        return "import { farewell } from './index.js';\nconsole.log(farewell('x'));\n";
      }
      if (target === "src/index.js") {
        return (
          "export function greet(name) {\n  return `Hello, ${name}`;\n}\n\n" +
          "export function farewell(name) {\n  return `Goodbye, ${name}`;\n}\n"
        );
      }
      return "// generated\n";
    },
  });
}

async function buildWithRepo(envOverrides = {}) {
  const config = loadConfig({
    ...TEST_ENV,
    REPO_LOCAL_PATH: repo.dir,
    GITHUB_OWNER: "fixture-owner",
    GITHUB_REPO: "fixture-repo",
    GITHUB_TOKEN: "ghp_fixtureTokenNeverReal0000000000000",
    BASE_BRANCH: "main",
    PR_MAX_REPAIR_ATTEMPTS: "1",
    ...envOverrides,
  });

  const logger = createLogger({ level: "silent" });
  octokit = createOctokitStub();

  service = createCodePrService({
    config,
    llm,
    logger,
    github: {
      createPullRequest: async (args) => {
        const { data } = await octokit.pulls.create({
          owner: config.GITHUB_OWNER,
          repo: config.GITHUB_REPO,
          ...args,
        });
        return { url: data.html_url, number: data.number };
      },
    },
  });

  // Capture the background promise so tests can await the pipeline instead of
  // polling, which keeps them fast and deterministic.
  pending = [];
  const originalEnqueue = service.enqueue.bind(service);
  service.enqueue = (id) => {
    const p = originalEnqueue(id);
    pending.push(p);
    return p;
  };

  app = buildApp({ config, llm, logger, codePr: service });
  return { config };
}

const settle = () => Promise.all(pending);

beforeEach(async () => {
  repo = await createFixtureRepo();
  llm = createFakeLlm();
  scriptModel();
  await buildWithRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

describe("job creation", () => {
  it("returns 202 immediately rather than blocking on the pipeline", async () => {
    const res = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);

    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe("queued");
    await settle();
  });

  it("rejects a task that is too short to act on", async () => {
    const res = await request(app).post("/api/pr").send({ task: "fix" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe("task");
  });

  it("rejects a target path that escapes the repo", async () => {
    const res = await request(app)
      .post("/api/pr")
      .send({ task: "Read something I should not", targetPaths: ["../../etc/passwd"] });
    expect(res.status).toBe(400);
  });

  it("rejects a hostile branch name", async () => {
    const res = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper", branch: "--upload-pack=/bin/sh" });
    expect(res.status).toBe(400);
  });

  it("returns the same job for a repeated Idempotency-Key", async () => {
    const first = await request(app)
      .post("/api/pr")
      .set("Idempotency-Key", "abc-123")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const second = await request(app)
      .post("/api/pr")
      .set("Idempotency-Key", "abc-123")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);

    // A retrying client must not open a second pull request.
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.body.reused).toBe(true);
    expect(await PrJob.countDocuments()).toBe(1);
  });

  it("409s on a second active job for the same branch", async () => {
    await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper", branch: "feature/shared" })
      .expect(202);

    const second = await request(app)
      .post("/api/pr")
      .send({ task: "Something else entirely here", branch: "feature/shared" });

    expect(second.status).toBe(409);
    await settle();
  });
});

describe("the pipeline up to the approval gate", () => {
  it("plans, writes multiple files, diffs, and parks awaiting approval", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({
        task: "Add a farewell helper to the greeting module",
        targetPaths: ["src/index.js"],
      })
      .expect(202);
    await settle();

    const { body } = await request(app).get(`/api/pr/${created.body.jobId}`).expect(200);

    expect(body.status).toBe("awaiting_approval");
    // Limitation 1: coordinated multi-file edit.
    expect(body.files).toHaveLength(2);
    expect(body.files.map((f) => f.path).sort()).toEqual([
      "src/farewell.test.js",
      "src/index.js",
    ]);
    expect(body.plan.summary).toContain("farewell");

    // Limitation 4: a reviewable diff exists before anything is pushed.
    const modified = body.files.find((f) => f.path === "src/index.js");
    expect(modified.diff).toContain("+export function farewell");
    expect(modified.action).toBe("modify");
  });

  it("pushes NOTHING before approval", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const job = await PrJob.findById(created.body.jobId);
    expect(job.status).toBe("awaiting_approval");

    // The origin still has only main, and no PR was opened.
    expect(await repo.originBranches()).toEqual(["main"]);
    expect(octokit.calls).toHaveLength(0);
    expect(job.prUrl).toBeNull();
  });

  it("gave the model the real contents of the target file", async () => {
    await request(app)
      .post("/api/pr")
      .send({
        task: "Add a farewell helper to the greeting module",
        targetPaths: ["src/index.js"],
      })
      .expect(202);
    await settle();

    // Limitation 2: codebase awareness. The planner prompt must contain the
    // file's actual contents and the detected conventions, not just the task.
    const plannerPrompt = llm.calls[0].messages.map((m) => m.content).join("\n");
    expect(plannerPrompt).toContain("export function greet");
    expect(plannerPrompt).toContain('"moduleSystem": "esm"');
    expect(plannerPrompt).toContain("fixture-project");
  });

  it("records a timeline of every state it passed through", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const { body } = await request(app).get(`/api/pr/${created.body.jobId}`);
    const statuses = body.timeline.map((t) => t.status);
    expect(statuses).toEqual(
      expect.arrayContaining([
        "queued",
        "planning",
        "generating",
        "verifying",
        "awaiting_approval",
      ]),
    );
  });

  it("fails cleanly when the planner returns an unusable plan", async () => {
    llm.script("openai/gpt-4o", { content: "I am not JSON at all." });

    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const job = await PrJob.findById(created.body.jobId);
    expect(job.status).toBe("failed");
    // Nothing was written, because the plan is validated before any file I/O.
    expect(job.files).toHaveLength(0);
  });
});

describe("verification gate", () => {
  it("blocks the push when the project's own tests fail", async () => {
    // Limitation 3. The fixture's test command genuinely fails; nothing here
    // is mocked.
    await repo.makeVerificationFail("test");
    await buildWithRepo({ PR_MAX_REPAIR_ATTEMPTS: "0" });
    scriptModel();

    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const job = await PrJob.findById(created.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.verification.tests.ok).toBe(false);
    expect(job.verification.tests.output).toContain("deliberate fixture failure");

    // The important part: broken code did not reach the remote.
    expect(await repo.originBranches()).toEqual(["main"]);
    expect(octokit.calls).toHaveLength(0);
  });

  it("attempts repair rounds up to the configured cap", async () => {
    await repo.makeVerificationFail("lint");
    await buildWithRepo({ PR_MAX_REPAIR_ATTEMPTS: "2" });
    scriptModel();

    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const job = await PrJob.findById(created.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.verification.repairAttempts).toBe(2);

    // The repair prompt must actually carry the failure output, or the model
    // is being asked to fix something it cannot see.
    const repairPrompts = llm.calls
      .map((c) => c.messages.map((m) => m.content).join("\n"))
      .filter((p) => p.includes("previous attempt failed verification"));
    expect(repairPrompts.length).toBeGreaterThan(0);
    expect(repairPrompts[0]).toContain("deliberate fixture failure");
  });

  it("records skipped rather than passed when no commands exist", async () => {
    // "We did not check" must not look like "it passed".
    const bare = await createFixtureRepo({
      files: { "package.json": JSON.stringify({ name: "no-scripts" }), "a.js": "//\n" },
    });
    const previous = repo;
    repo = bare;
    await buildWithRepo();
    llm.script("openai/gpt-4o", {
      content: (messages) =>
        messages
          .map((m) => m.content)
          .join("\n")
          .includes("planning a code change")
          ? JSON.stringify({
              summary: "touch a file",
              files: [{ path: "a.js", action: "modify", reason: "because" }],
              notes: "",
            })
          : "// updated\n",
    });

    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Update the a.js module with a comment" })
      .expect(202);
    await settle();

    const job = await PrJob.findById(created.body.jobId);
    expect(job.verification.lint.skipped).toBe(true);
    expect(job.verification.tests.skipped).toBe(true);
    expect(job.status).toBe("awaiting_approval");

    await previous.cleanup();
  });
});

describe("approval", () => {
  it("commits, pushes to the origin, and opens a PR", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const res = await request(app).post(`/api/pr/${created.body.jobId}/approve`).expect(200);

    expect(res.body.status).toBe("completed");
    expect(res.body.prUrl).toBe("https://github.com/fixture-owner/fixture-repo/pull/42");
    expect(res.body.prNumber).toBe(42);

    // The branch really is on the origin, with the new code in it.
    const branches = await repo.originBranches();
    expect(branches).toContain(res.body.branch);
    const pushed = await repo.readOrigin(res.body.branch, "src/index.js");
    expect(pushed).toContain("farewell");
  });

  it("writes a PR body carrying the plan, files and verification evidence", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();
    await request(app).post(`/api/pr/${created.body.jobId}/approve`).expect(200);

    const [prCall] = octokit.calls;
    expect(prCall.title).toContain("farewell");
    expect(prCall.body).toContain("## Verification");
    expect(prCall.body).toContain("src/index.js");
    expect(prCall.body).toContain("Lint:");
    expect(prCall.base).toBe("main");
  });

  it("refuses to approve a job that is not awaiting approval", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    await request(app).post(`/api/pr/${created.body.jobId}/approve`).expect(200);
    // Approving twice would push twice and open a duplicate PR.
    const again = await request(app).post(`/api/pr/${created.body.jobId}/approve`);
    expect(again.status).toBe(409);
    expect(octokit.calls).toHaveLength(1);
  });

  it("cleans up the worktree after a successful push", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();
    await request(app).post(`/api/pr/${created.body.jobId}/approve`).expect(200);

    const worktrees = await repo.worktrees();
    expect(worktrees.filter((w) => w.includes(WORKTREE_PREFIX))).toHaveLength(0);
  });
});

describe("rejection", () => {
  it("discards the branch and cleans the worktree", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    const res = await request(app).post(`/api/pr/${created.body.jobId}/reject`).expect(200);
    expect(res.body.status).toBe("cancelled");

    expect(await repo.localBranches()).not.toContain(res.body.branch);
    expect((await repo.worktrees()).filter((w) => w.includes(WORKTREE_PREFIX))).toHaveLength(0);
    expect(await repo.originBranches()).toEqual(["main"]);
    expect(octokit.calls).toHaveLength(0);
  });
});

describe("crash recovery", () => {
  it("fails interrupted jobs and removes their stray worktrees at boot", async () => {
    // Simulate a process killed mid-generation: a job frozen in a transient
    // state, and a worktree still on disk.
    const job = await PrJob.create({
      task: "Something that was interrupted mid-flight",
      branch: "feature/interrupted",
      baseBranch: "main",
      model: "openai/gpt-4o",
      status: "generating",
      timeline: [{ status: "generating", at: new Date() }],
    });

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const strayDir = path.join(os.tmpdir(), `${WORKTREE_PREFIX}${job._id}`);
    await run("git", ["worktree", "add", "-b", "feature/interrupted", strayDir, "main"], {
      cwd: repo.dir,
    });

    const result = await service.recoverInterruptedJobs();

    expect(result.recovered).toContain(String(job._id));
    expect(result.worktrees).toContain(String(job._id));

    const reloaded = await PrJob.findById(job._id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.error).toMatch(/restart/i);

    expect((await repo.worktrees()).filter((w) => w.includes(WORKTREE_PREFIX))).toHaveLength(0);
    await fs.rm(strayDir, { recursive: true, force: true });
  });

  it("leaves a job that is legitimately awaiting approval alone", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();

    await service.recoverInterruptedJobs();

    // Its worktree holds the diff a human is about to review; reaping it would
    // destroy work that is waiting on a person, not on the machine.
    const job = await PrJob.findById(created.body.jobId);
    expect(job.status).toBe("awaiting_approval");
    expect((await repo.worktrees()).some((w) => w.includes(String(job._id)))).toBe(true);
  });
});

describe("secret hygiene", () => {
  it("never writes the GitHub token into git config or the remote URL", async () => {
    const created = await request(app)
      .post("/api/pr")
      .send({ task: "Add a farewell helper to the greeting module" })
      .expect(202);
    await settle();
    await request(app).post(`/api/pr/${created.body.jobId}/approve`).expect(200);

    const gitConfig = await fs.readFile(path.join(repo.dir, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain("ghp_");

    // Nor into anything the API hands back.
    const { text } = await request(app).get(`/api/pr/${created.body.jobId}`);
    expect(text).not.toContain("ghp_");
  });
});
