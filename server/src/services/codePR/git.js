/**
 * Git, via execFile with argument arrays.
 *
 * Never `exec`, never string interpolation into a command line: every
 * untrusted value (branch names, paths, commit messages, remote URLs) is
 * passed as a separate argv entry, so there is no shell to inject into.
 *
 * Jobs operate in a dedicated worktree, never on the user's checked-out
 * branch. Someone running this against their own working repo should not
 * discover it has switched branches under them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

import { AppError } from "../../lib/errors.js";
import { redactString } from "../../lib/redact.js";

const execFileAsync = promisify(execFile);

/** Where per-job worktrees live, relative to the OS temp dir. */
export const WORKTREE_PREFIX = "llm-council-job-";

export class GitError extends AppError {
  get code() {
    return "GIT_ERROR";
  }
}

/**
 * Run a git command.
 *
 * @param {string[]} args        argv after `git`. Never a single string.
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>} [options.env] Extra env for this call only.
 */
export async function git(args, { cwd, timeoutMs = 60_000, env } = {}) {
  if (!Array.isArray(args)) throw new TypeError("git() requires an argument array");

  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // Never let git prompt: in a server process that is an indefinite hang.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        ...env,
      },
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    // git puts useful detail on stderr, and stderr can quote a remote URL —
    // which is where a token would be if one ever leaked into a remote.
    const detail = redactString(err.stderr?.toString() || err.message || "git failed");
    throw new GitError(`git ${args[0]} failed: ${detail}`, { cause: err });
  }
}

export async function isGitRepo(dir) {
  try {
    const { stdout } = await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(cwd) {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

export async function branchExists(cwd, branch) {
  try {
    // `--` and a full refname keep a hostile branch name from being read as
    // an option even here.
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an isolated worktree for a job.
 *
 * @returns {Promise<{dir: string, branch: string, cleanup: () => Promise<void>}>}
 */
export async function createWorktree({ repoPath, branch, baseBranch, jobId }) {
  const { tmpdir } = await import("node:os");
  const dir = path.join(tmpdir(), `${WORKTREE_PREFIX}${jobId}`);

  // A stale directory from a crashed run would make `worktree add` fail.
  await fs.rm(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], { cwd: repoPath });

  await git(["worktree", "add", "-b", branch, dir, baseBranch], { cwd: repoPath });

  return {
    dir,
    branch,
    async cleanup({ deleteBranch = false } = {}) {
      // Best-effort throughout: cleanup runs in a `finally`, and a cleanup
      // failure must not mask the error that triggered it.
      try {
        await git(["worktree", "remove", "--force", dir], { cwd: repoPath });
      } catch {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await git(["worktree", "prune"], { cwd: repoPath }).catch(() => {});
      }
      if (deleteBranch) {
        await git(["branch", "-D", branch], { cwd: repoPath }).catch(() => {});
      }
    },
  };
}

/**
 * Remove worktrees left behind by a crash.
 *
 * Called at boot. Without this, a process killed mid-job leaks a directory and
 * a registered worktree that blocks the next job on that branch.
 *
 * @param {string} repoPath
 * @param {Set<string>|string[]} [activeJobIds] Job ids that are legitimately running.
 */
export async function pruneStaleWorktrees(repoPath, activeJobIds = []) {
  const active = new Set(activeJobIds);
  const removed = [];

  let stdout = "";
  try {
    ({ stdout } = await git(["worktree", "list", "--porcelain"], { cwd: repoPath }));
  } catch {
    return removed;
  }

  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length).trim();
    const base = path.basename(dir);
    if (!base.startsWith(WORKTREE_PREFIX)) continue;

    const jobId = base.slice(WORKTREE_PREFIX.length);
    if (active.has(jobId)) continue;

    await git(["worktree", "remove", "--force", dir], { cwd: repoPath }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(jobId);
  }

  await git(["worktree", "prune"], { cwd: repoPath }).catch(() => {});
  return removed;
}

/** Unified diff for one file against HEAD. */
export async function diffFile(cwd, relativePath) {
  const { stdout } = await git(
    ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", relativePath],
    { cwd },
  );
  return stdout;
}

/** Unified diff for everything staged or unstaged. */
export async function diffAll(cwd) {
  const { stdout } = await git(["diff", "--no-color", "--no-ext-diff", "HEAD"], { cwd });
  return stdout;
}

export async function stageAll(cwd) {
  await git(["add", "-A"], { cwd });
}

export async function commit(
  cwd,
  message,
  { author = "LLM Council <noreply@llm-council>" } = {},
) {
  // `-m` with the message as its own argv entry: a message containing
  // backticks or `$(...)` is inert.
  await git(
    [
      "-c",
      `user.name=${author.split(" <")[0]}`,
      "-c",
      `user.email=${extractEmail(author)}`,
      "commit",
      "-m",
      message,
    ],
    {
      cwd,
    },
  );
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function extractEmail(author) {
  const match = /<([^>]+)>/.exec(author);
  return match ? match[1] : "noreply@llm-council";
}

/**
 * Push a branch using a token, without the token ever being persisted.
 *
 * The token is passed via an in-memory askpass helper rather than being
 * written into the remote URL or `.git/config`. Putting it in the URL would
 * leak it into `.git/config`, into `ps` output, and into git's own error
 * messages on failure.
 */
export async function pushBranch({ cwd, remote = "origin", branch, token }) {
  const env = {};

  if (token) {
    // Credentials arrive through the environment, which — unlike argv — is not
    // visible in a process listing.
    env.GIT_ASKPASS = await writeAskpassHelper();
    env.GIT_USERNAME = "x-access-token";
    env.GIT_PASSWORD = token;
    env.GIT_TERMINAL_PROMPT = "0";
  }

  try {
    // Push to the clone's own remote rather than a URL assembled from
    // GITHUB_OWNER/GITHUB_REPO. Those are for the PR API call; the git remote
    // is whatever the operator actually cloned from, which may be an SSH
    // remote, an enterprise host, or a mirror. Rewriting it here would push to
    // the wrong place while looking correct.
    return await git(["push", "--set-upstream", remote, `${branch}:${branch}`], {
      cwd,
      env,
      timeoutMs: 120_000,
    });
  } finally {
    if (env.GIT_ASKPASS) await fs.rm(env.GIT_ASKPASS, { force: true }).catch(() => {});
  }
}

/**
 * Write a tiny askpass script that echoes credentials from the environment.
 * Git calls it, reads stdout, and the secret never touches disk or argv.
 */
async function writeAskpassHelper() {
  const { tmpdir } = await import("node:os");
  const file = path.join(
    tmpdir(),
    `llm-council-askpass-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  );
  await fs.writeFile(
    file,
    `#!/bin/sh
case "$1" in
  Username*) printf '%s' "$GIT_USERNAME" ;;
  Password*) printf '%s' "$GIT_PASSWORD" ;;
esac
`,
    { mode: 0o700 },
  );
  return file;
}
