/**
 * A throwaway git repository for Code+PR tests.
 *
 * Creates a working clone plus a bare "origin" on local disk, so a push is a
 * genuine push — it just goes to a directory instead of github.com. That keeps
 * the pipeline honest end to end while making a real network call impossible.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const run = (args, cwd) =>
  execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@test.local",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@test.local",
    },
  });

/** Files the fixture repo starts with. */
const DEFAULT_FILES = {
  "package.json": JSON.stringify(
    {
      name: "fixture-project",
      version: "1.0.0",
      type: "module",
      scripts: {
        // Both are real commands whose pass/fail the test can control by
        // writing a marker file — no mocking of the verification step.
        lint: "node scripts/check.mjs lint",
        test: "node scripts/check.mjs test",
      },
    },
    null,
    2,
  ),
  "src/index.js": "export function greet(name) {\n  return `Hello, ${name}`;\n}\n",
  "src/util.js": "export const VERSION = 1;\n",
  "README.md": "# Fixture project\n",
  "scripts/check.mjs": `// Verification stub. Fails when FAIL_<kind> exists, so a test can make
// the project's own lint or tests fail without any mocking.
import fs from "node:fs";
const kind = process.argv[2] ?? "lint";
const marker = new URL(\`../FAIL_\${kind.toUpperCase()}\`, import.meta.url);
if (fs.existsSync(marker)) {
  console.error(\`\${kind} failed: deliberate fixture failure\`);
  process.exit(1);
}
console.log(\`\${kind} passed\`);
`,
};

/**
 * @returns {Promise<{dir: string, originDir: string, cleanup: () => Promise<void>, readOrigin: (ref: string, file: string) => Promise<string>, originBranches: () => Promise<string[]>}>}
 */
export async function createFixtureRepo({ files = DEFAULT_FILES } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-council-fixture-"));
  const dir = path.join(root, "work");
  const originDir = path.join(root, "origin.git");

  await fs.mkdir(dir, { recursive: true });

  // The bare repo that stands in for GitHub.
  await run(["init", "--bare", "--initial-branch=main", originDir], root);

  await run(["init", "--initial-branch=main"], dir);
  await run(["config", "user.name", "Fixture"], dir);
  await run(["config", "user.email", "fixture@test.local"], dir);
  // Keep the fixture independent of the host's git config.
  await run(["config", "commit.gpgsign", "false"], dir);

  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  await run(["add", "-A"], dir);
  await run(["commit", "-m", "initial commit"], dir);
  await run(["remote", "add", "origin", originDir], dir);
  await run(["push", "-u", "origin", "main"], dir);

  return {
    dir,
    originDir,

    /** Read a file as it exists on the bare origin. */
    async readOrigin(ref, file) {
      const { stdout } = await run(["show", `${ref}:${file}`], originDir);
      return stdout;
    },

    /** Branches that actually reached the origin. */
    async originBranches() {
      const { stdout } = await run(["branch", "--format=%(refname:short)"], originDir);
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    },

    /** Branches in the working clone. */
    async localBranches() {
      const { stdout } = await run(["branch", "--format=%(refname:short)"], dir);
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    },

    /** Registered worktrees, used to prove cleanup happened. */
    async worktrees() {
      const { stdout } = await run(["worktree", "list", "--porcelain"], dir);
      return stdout
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim());
    },

    /** Make the project's own lint or tests fail. */
    async makeVerificationFail(kind = "test") {
      await fs.writeFile(path.join(dir, `FAIL_${kind.toUpperCase()}`), "");
      await run(["add", "-A"], dir);
      await run(["commit", "-m", `make ${kind} fail`], dir);
    },

    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** An Octokit stub that records calls instead of opening a pull request. */
export function createOctokitStub({ shouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    pulls: {
      create: async (params) => {
        calls.push(params);
        if (shouldFail) throw new Error("GitHub said no");
        return {
          data: {
            html_url: `https://github.com/${params.owner}/${params.repo}/pull/42`,
            number: 42,
          },
        };
      },
    },
  };
}
