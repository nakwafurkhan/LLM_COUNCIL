/**
 * Containment.
 *
 * These inputs are chosen by a language model. Every case below is something a
 * confused or manipulated model can plausibly emit, and each one reaches
 * either the filesystem or `execFile`. A failure here is a sandbox escape or a
 * command injection, not a cosmetic bug.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertInsideRepo,
  assertValidBranchName,
  branchNameFromTask,
} from "../../src/services/codePR/paths.js";
import { ValidationError } from "../../src/lib/errors.js";

let repoRoot;
let outsideDir;

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paths-repo-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-outside-"));
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "index.js"), "// hi\n");
  fs.writeFileSync(path.join(outsideDir, "secrets.txt"), "top secret\n");
});

afterAll(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("assertInsideRepo — accepts", () => {
  it("a simple relative path", () => {
    expect(assertInsideRepo(repoRoot, "src/index.js")).toBe(
      path.join(repoRoot, "src/index.js"),
    );
  });

  it("a file that does not exist yet", () => {
    expect(assertInsideRepo(repoRoot, "src/new/deep/file.js")).toContain(repoRoot);
  });

  it("a path with internal dots that stays inside", () => {
    expect(assertInsideRepo(repoRoot, "src/./index.js")).toBe(
      path.join(repoRoot, "src/index.js"),
    );
    // Descends then comes back: still inside, so still allowed.
    expect(assertInsideRepo(repoRoot, "src/sub/../index.js")).toBe(
      path.join(repoRoot, "src/index.js"),
    );
  });
});

describe("assertInsideRepo — rejects", () => {
  it.each([
    ["../../etc/passwd", "classic traversal"],
    ["../outside.txt", "single level up"],
    ["src/../../escape.js", "traversal after a valid prefix"],
    ["/etc/passwd", "absolute path"],
    ["/tmp/anything", "absolute path in temp"],
    ["src/../../../../../../root/.ssh/id_rsa", "deep traversal"],
  ])("%s (%s)", (candidate) => {
    expect(() => assertInsideRepo(repoRoot, candidate)).toThrow(ValidationError);
  });

  it("a null byte, which can truncate a path in a C-level API", () => {
    expect(() => assertInsideRepo(repoRoot, "src/index.js\0.txt")).toThrow(ValidationError);
  });

  it("an empty or non-string path", () => {
    expect(() => assertInsideRepo(repoRoot, "")).toThrow(ValidationError);
    expect(() => assertInsideRepo(repoRoot, null)).toThrow(ValidationError);
  });

  it("a sibling directory sharing the repo's name prefix", () => {
    // `/tmp/repo-evil` must not pass a naive startsWith("/tmp/repo") check.
    const sibling = `${repoRoot}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(() => assertInsideRepo(repoRoot, `../${path.basename(sibling)}/x.js`)).toThrow(
        ValidationError,
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("a symlink pointing outside the repo", () => {
    // Lexical checks pass here — only resolving the link catches it.
    const link = path.join(repoRoot, "escape-link");
    fs.symlinkSync(outsideDir, link, "dir");
    try {
      expect(() => assertInsideRepo(repoRoot, "escape-link/secrets.txt")).toThrow(
        ValidationError,
      );
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("a new file underneath a symlinked directory", () => {
    // The file does not exist, so the check must resolve its nearest
    // existing ancestor instead of giving up.
    const link = path.join(repoRoot, "linked-dir");
    fs.symlinkSync(outsideDir, link, "dir");
    try {
      expect(() => assertInsideRepo(repoRoot, "linked-dir/brand-new.js")).toThrow(
        ValidationError,
      );
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

describe("assertValidBranchName — accepts", () => {
  it.each(["feature/add-thing", "fix-123", "release/v1.2.3", "user/name/topic", "a"])(
    "%s",
    (name) => {
      expect(assertValidBranchName(name)).toBe(name);
    },
  );

  it("trims surrounding whitespace", () => {
    expect(assertValidBranchName("  feature/x  ")).toBe("feature/x");
  });
});

describe("assertValidBranchName — rejects", () => {
  it.each([
    ["--upload-pack=/bin/sh", "git option injection — RCE on some git paths"],
    ["--force", "leading dash parsed as a flag"],
    ["-D", "looks like a delete flag"],
    ["a;rm -rf /", "shell metacharacters"],
    ["a && curl evil.com", "command chaining"],
    ["a|tee /etc/passwd", "pipe"],
    ["$(whoami)", "command substitution"],
    ["`whoami`", "backtick substitution"],
    ["feature/../../../etc", "traversal"],
    ["a..b", "double dot, which git rejects too"],
    ["a//b", "double slash"],
    ["/leading-slash", "leading slash"],
    ["trailing-slash/", "trailing slash"],
    ["ends-with-dot.", "trailing dot"],
    ["thing.lock", "reserved .lock suffix"],
    ["has space", "space"],
    ["has\ttab", "tab"],
    ["has\nnewline", "newline"],
    ["@", "bare @"],
    ["ref@{0}", "reflog syntax"],
    ["emoji-🚀", "non-ascii"],
    ["", "empty"],
    ["   ", "whitespace only"],
  ])("%s (%s)", (name) => {
    expect(() => assertValidBranchName(name)).toThrow(ValidationError);
  });

  it("a 300-character name", () => {
    expect(() => assertValidBranchName("a".repeat(300))).toThrow(ValidationError);
  });

  it("rejects rather than silently sanitising", () => {
    // Rewriting `a;rm -rf /` into `a-rm-rf` would create a branch nobody asked
    // for and hide the fact that something tried.
    try {
      assertValidBranchName("a;rm -rf /");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.fields[0].path).toBe("branch");
    }
  });
});

describe("branchNameFromTask", () => {
  it("produces a valid branch from arbitrary prose", () => {
    const name = branchNameFromTask("Add a /health endpoint & fix the 500!");
    expect(() => assertValidBranchName(name)).not.toThrow();
    expect(name).toMatch(/^llm-council\/add-a-health-endpoint/);
  });

  it("survives a task with nothing usable in it", () => {
    const name = branchNameFromTask("!!! ???");
    expect(() => assertValidBranchName(name)).not.toThrow();
    expect(name).toContain("task");
  });

  it("stays within the length limit for a very long task", () => {
    const name = branchNameFromTask("word ".repeat(200));
    expect(name.length).toBeLessThan(80);
    expect(() => assertValidBranchName(name)).not.toThrow();
  });

  it("is unique across calls, so two similar tasks do not collide", () => {
    expect(branchNameFromTask("same task")).not.toBe(branchNameFromTask("same task"));
  });
});
