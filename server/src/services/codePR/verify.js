/**
 * The verification gate.
 *
 * Closes limitation #3: the old flow pushed whatever the model produced, so a
 * PR could arrive with code that does not lint, does not compile, and does not
 * pass the project's own tests.
 *
 * Nothing is pushed until the project's own lint and test commands pass in the
 * worktree. On failure the output is fed back for a bounded number of repair
 * rounds; if it still fails the job ends `failed` with the logs attached. A
 * broken PR is worse than no PR.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

import { redactString } from "../../lib/redact.js";

/** Keep stored output bounded — a failing test suite can emit megabytes. */
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Auto-detect the project's commands when they are not configured.
 * Reading them from package.json means we run what the project actually uses.
 */
export async function detectCommands(repoRoot) {
  let pkg = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  } catch {
    return { lint: null, test: null };
  }

  const scripts = pkg.scripts ?? {};
  return {
    lint: scripts.lint ? "npm run lint" : null,
    // `npm test` on a project with no test script prints an error and exits 1,
    // which would fail every job for the wrong reason.
    test: scripts.test ? "npm test" : null,
  };
}

/**
 * Run one command in the worktree.
 *
 * Uses a shell deliberately — these are configured command strings like
 * `npm run lint`, not model output. Model-controlled values never reach here;
 * the operator sets them via PR_LINT_CMD / PR_TEST_CMD or they come from the
 * target repo's own package.json.
 */
export function runCommand(command, { cwd, timeoutMs = 300_000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const child = execFile(
      command,
      {
        cwd,
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        resolve({
          ok: !err,
          command,
          exitCode: err?.code ?? 0,
          timedOut: Boolean(err?.killed),
          output: truncateOutput(redactString(output)),
          durationMs: Date.now() - startedAt,
        });
      },
    );

    child.on("error", () => {
      resolve({
        ok: false,
        command,
        exitCode: -1,
        output: `Failed to start: ${command}`,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Keep the tail: the failure summary is almost always at the end. */
function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `… (truncated ${text.length - MAX_OUTPUT_CHARS} characters)\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

/**
 * Run lint and tests.
 *
 * A command that is neither configured nor detectable is recorded as skipped
 * rather than silently passing — "we did not check" and "it passed" must not
 * look the same on the job record.
 */
export async function verify({ cwd, config }) {
  const detected = await detectCommands(cwd);
  const lintCmd = config.PR_LINT_CMD ?? detected.lint;
  const testCmd = config.PR_TEST_CMD ?? detected.test;
  const timeoutMs = config.PR_VERIFY_TIMEOUT_MS;

  const lint = lintCmd
    ? await runCommand(lintCmd, { cwd, timeoutMs })
    : {
        ok: true,
        skipped: true,
        command: null,
        output: "No lint command configured or detected.",
      };

  const tests = testCmd
    ? await runCommand(testCmd, { cwd, timeoutMs })
    : {
        ok: true,
        skipped: true,
        command: null,
        output: "No test command configured or detected.",
      };

  return {
    ok: lint.ok && tests.ok,
    lint,
    tests,
  };
}

/** Format a failure for the repair prompt. */
export function buildRepairContext(result) {
  const parts = [];
  if (!result.lint.ok && !result.lint.skipped) {
    parts.push(
      `### Lint failed (\`${result.lint.command}\`, exit ${result.lint.exitCode})\n${result.lint.output}`,
    );
  }
  if (!result.tests.ok && !result.tests.skipped) {
    parts.push(
      `### Tests failed (\`${result.tests.command}\`, exit ${result.tests.exitCode})\n${result.tests.output}`,
    );
  }
  return parts.join("\n\n");
}
