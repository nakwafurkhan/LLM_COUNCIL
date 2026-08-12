/**
 * Containment.
 *
 * Everything here exists because a model chooses these strings. A path or a
 * branch name arriving from an LLM is untrusted input in exactly the same
 * sense as one arriving from a browser, and it reaches `execFile` and the
 * filesystem. Treat every function in this file as a security boundary.
 */
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

import { ValidationError } from "../../lib/errors.js";

/**
 * Resolve a repo-relative path and prove it stays inside the repo.
 *
 * `path.resolve` alone is not enough: a symlink inside the repo can point
 * outside it, so the real path is checked too when the file exists.
 *
 * @param {string} repoRoot Absolute path to the worktree.
 * @param {string} candidate Repo-relative path from a plan.
 * @returns {string} Absolute, verified path.
 */
export function assertInsideRepo(repoRoot, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new ValidationError("Path must be a non-empty string", [
      { path: "path", message: "must be a non-empty string" },
    ]);
  }
  if (candidate.includes("\0")) {
    throw new ValidationError("Path must not contain null bytes", [
      { path: "path", message: "contains a null byte" },
    ]);
  }
  if (path.isAbsolute(candidate)) {
    throw new ValidationError(`Path must be repo-relative: ${candidate}`, [
      { path: "path", message: "must be repo-relative, not absolute" },
    ]);
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, candidate);

  // The separator check stops `/repo-evil` passing a naive startsWith("/repo").
  const withinLexically = resolved === root || resolved.startsWith(root + path.sep);
  if (!withinLexically) {
    throw new ValidationError(`Path escapes the repository: ${candidate}`, [
      { path: "path", message: "resolves outside the repository root" },
    ]);
  }

  // Symlink check: only meaningful for paths that already exist. For a new
  // file, check the nearest existing ancestor instead — a symlinked parent
  // directory is the same escape by another route.
  let probe = resolved;
  while (!fs.existsSync(probe) && probe !== root && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
  }
  if (fs.existsSync(probe)) {
    const real = fs.realpathSync(probe);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ValidationError(`Path escapes the repository via a symlink: ${candidate}`, [
        { path: "path", message: "resolves outside the repository through a symlink" },
      ]);
    }
  }

  return resolved;
}

/** Convenience: validate a whole plan's worth of paths at once. */
export function assertAllInsideRepo(repoRoot, candidates) {
  return candidates.map((c) => assertInsideRepo(repoRoot, c));
}

/** Characters git accepts that we are willing to accept. */
const BRANCH_ALLOWED = /^[A-Za-z0-9._/-]+$/;
const MAX_BRANCH_LENGTH = 200;

/**
 * Validate a branch name.
 *
 * Rejects rather than sanitises: silently rewriting `a;rm -rf /` into
 * `a-rm-rf` produces a branch nobody asked for and hides the fact that
 * something tried. The one exception is whitespace, trimmed as a courtesy.
 *
 * The dangerous cases are not only shell metacharacters (we use execFile with
 * argument arrays, so those cannot reach a shell) but git's own option
 * parsing: a name beginning with `-` can be read as a flag, and
 * `--upload-pack=...` is remote code execution on some git paths.
 */
export function assertValidBranchName(name) {
  const value = String(name ?? "").trim();
  const reject = (message) => {
    throw new ValidationError(`Invalid branch name: ${message}`, [{ path: "branch", message }]);
  };

  if (!value) reject("must not be empty");
  if (value.length > MAX_BRANCH_LENGTH)
    reject(`must be at most ${MAX_BRANCH_LENGTH} characters`);
  if (!BRANCH_ALLOWED.test(value)) reject("may only contain A-Z a-z 0-9 . _ / -");
  // A leading dash can be parsed by git as an option rather than a ref.
  if (value.startsWith("-")) reject("must not start with '-'");
  if (value.includes("..")) reject("must not contain '..'");
  if (value.includes("//")) reject("must not contain '//'");
  if (value.startsWith("/") || value.endsWith("/")) reject("must not start or end with '/'");
  if (value.endsWith(".") || value.endsWith(".lock"))
    reject("must not end with '.' or '.lock'");
  if (value.includes("@{")) reject("must not contain '@{'");
  if (value === "@") reject("must not be '@'");
  // Git refuses these itself, but failing here gives a better message.
  // eslint-disable-next-line no-control-regex -- control chars are exactly what we are screening for
  if (/[\x00-\x20\x7f]/.test(value)) reject("must not contain control characters or spaces");

  return value;
}

/**
 * Derive a branch name from a task description.
 * Used when the caller does not supply one.
 */
export function branchNameFromTask(task, { prefix = "llm-council" } = {}) {
  const slug = String(task ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // Timestamp alone collides: two jobs created in the same millisecond would
  // generate the same branch and the second would 409 against the
  // one-active-job-per-branch guard. The random suffix makes that impossible.
  const stamp = Date.now().toString(36);
  const nonce = randomBytes(3).toString("hex");
  return assertValidBranchName(`${prefix}/${slug || "task"}-${stamp}-${nonce}`);
}
