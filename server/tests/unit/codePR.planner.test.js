/**
 * Planner parsing and the verification gate's pure parts.
 *
 * The plan is the last point at which a bad model response is cheap to reject.
 * Past it, we start writing files.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parsePlan,
  validatePlanAgainstRepo,
  stripCodeFences,
} from "../../src/services/codePR/planner.js";
import {
  detectCommands,
  buildRepairContext,
  runCommand,
} from "../../src/services/codePR/verify.js";
import { prTitleFromTask, buildPrBody } from "../../src/services/codePR/github.js";
import { ValidationError } from "../../src/lib/errors.js";

let repoRoot;

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-repo-"));
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "a.js"), "//\n");
});

afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

const validPlan = {
  summary: "Add a thing",
  files: [{ path: "src/a.js", action: "modify", reason: "because" }],
  notes: "",
};

describe("parsePlan", () => {
  it("parses bare JSON", () => {
    expect(parsePlan(JSON.stringify(validPlan)).files).toHaveLength(1);
  });

  it("parses fenced JSON", () => {
    expect(parsePlan("```json\n" + JSON.stringify(validPlan) + "\n```").summary).toBe(
      "Add a thing",
    );
  });

  it("parses JSON after a preamble", () => {
    expect(parsePlan(`Here is the plan:\n${JSON.stringify(validPlan)}`).files).toHaveLength(1);
  });

  it("defaults notes when omitted", () => {
    const plan = parsePlan(JSON.stringify({ summary: "s", files: validPlan.files }));
    expect(plan.notes).toBe("");
  });

  it("rejects prose with no JSON at all", () => {
    // Unlike the chairman, a plan has no safe fallback: acting on a guess here
    // means writing files the model never actually specified.
    expect(() => parsePlan("I'll just edit some files.")).toThrow(ValidationError);
  });

  it("rejects a plan with no files", () => {
    expect(() => parsePlan(JSON.stringify({ summary: "s", files: [] }))).toThrow(
      ValidationError,
    );
  });

  it("rejects a plan missing a summary", () => {
    expect(() => parsePlan(JSON.stringify({ files: validPlan.files }))).toThrow(
      ValidationError,
    );
  });

  it("rejects an unknown action", () => {
    expect(() =>
      parsePlan(
        JSON.stringify({
          summary: "s",
          files: [{ path: "a.js", action: "obliterate", reason: "why not" }],
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("rejects a traversal path at the schema layer", () => {
    expect(() =>
      parsePlan(
        JSON.stringify({
          summary: "s",
          files: [{ path: "../../etc/passwd", action: "modify", reason: "evil" }],
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("reports which field was wrong", () => {
    try {
      parsePlan(JSON.stringify({ summary: "s", files: [{ path: "a.js" }] }));
    } catch (err) {
      expect(err.fields.some((f) => f.path.includes("action"))).toBe(true);
    }
  });
});

describe("validatePlanAgainstRepo", () => {
  it("accepts a plan inside the repo and under the cap", () => {
    expect(validatePlanAgainstRepo(validPlan, { repoRoot, maxFiles: 10 })).toBe(validPlan);
  });

  it("enforces the file cap", () => {
    const big = {
      summary: "s",
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `src/f${i}.js`,
        action: "create",
        reason: "r",
      })),
    };
    expect(() => validatePlanAgainstRepo(big, { repoRoot, maxFiles: 3 })).toThrow(
      ValidationError,
    );
  });

  it("rejects a duplicate path, which would make one generation silently win", () => {
    const dup = {
      summary: "s",
      files: [
        { path: "src/a.js", action: "modify", reason: "r" },
        { path: "src/a.js", action: "delete", reason: "r" },
      ],
    };
    expect(() => validatePlanAgainstRepo(dup, { repoRoot, maxFiles: 10 })).toThrow(
      ValidationError,
    );
  });

  it("rejects before touching the filesystem", () => {
    const evil = {
      summary: "s",
      files: [{ path: "src/../../escape.js", action: "create", reason: "r" }],
    };
    expect(() => validatePlanAgainstRepo(evil, { repoRoot, maxFiles: 10 })).toThrow(
      ValidationError,
    );
    expect(fs.existsSync(path.join(path.dirname(repoRoot), "escape.js"))).toBe(false);
  });
});

describe("stripCodeFences", () => {
  it("removes a fence the model added despite instructions", () => {
    expect(stripCodeFences("```js\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(stripCodeFences("```\nplain\n```")).toBe("plain");
  });

  it("leaves unfenced content alone", () => {
    expect(stripCodeFences("const a = 1;")).toBe("const a = 1;");
  });

  it("does not mangle code containing a fence-like line inside", () => {
    const md = "const doc = `\n```\nnested\n```\n`;";
    expect(stripCodeFences(md)).toBe(md);
  });
});

describe("detectCommands", () => {
  it("finds lint and test scripts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
    );
    expect(await detectCommands(dir)).toEqual({ lint: "npm run lint", test: "npm test" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a project with no test script", async () => {
    // `npm test` with no script exits 1, which would fail every job for a
    // reason that has nothing to do with the change.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(await detectCommands(dir)).toEqual({ lint: null, test: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survives a missing or malformed package.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
    expect(await detectCommands(dir)).toEqual({ lint: null, test: null });
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(await detectCommands(dir)).toEqual({ lint: null, test: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runCommand", () => {
  it("reports success", async () => {
    const result = await runCommand("echo hello", { cwd: os.tmpdir() });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("reports failure with the output", async () => {
    const result = await runCommand("echo boom && exit 3", { cwd: os.tmpdir() });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
  });

  it("enforces a timeout instead of hanging the job", async () => {
    const result = await runCommand("sleep 5", { cwd: os.tmpdir(), timeoutMs: 200 });
    expect(result.ok).toBe(false);
  });
});

describe("buildRepairContext", () => {
  it("includes only the checks that actually failed", () => {
    const context = buildRepairContext({
      lint: {
        ok: false,
        skipped: false,
        command: "npm run lint",
        exitCode: 1,
        output: "lint bad",
      },
      tests: { ok: true, skipped: false, command: "npm test", output: "fine" },
    });
    expect(context).toContain("Lint failed");
    expect(context).toContain("lint bad");
    expect(context).not.toContain("Tests failed");
  });

  it("ignores skipped checks", () => {
    expect(
      buildRepairContext({
        lint: { ok: true, skipped: true },
        tests: { ok: true, skipped: true },
      }),
    ).toBe("");
  });
});

describe("PR presentation", () => {
  it("truncates a long task at a word boundary", () => {
    const title = prTitleFromTask(
      "Refactor the authentication middleware so that it validates tokens before hitting the database",
    );
    expect(title.length).toBeLessThanOrEqual(73);
    expect(title).toMatch(/…$/);
    expect(title).not.toMatch(/\s…$/);
  });

  it("leaves a short task alone", () => {
    expect(prTitleFromTask("Add a health endpoint")).toBe("Add a health endpoint");
  });

  it("uses only the first line of a multi-line task", () => {
    expect(prTitleFromTask("Add a health endpoint\n\nMore detail here")).toBe(
      "Add a health endpoint",
    );
  });

  it("builds a body a reviewer can act on", () => {
    const body = buildPrBody({
      task: "Add a farewell helper",
      model: "openai/gpt-4o",
      plan: { summary: "Add the helper and a test", notes: "ESM only" },
      files: [
        { path: "src/index.js", action: "modify" },
        { path: "src/farewell.test.js", action: "create" },
      ],
      verification: {
        lint: { ok: true, command: "npm run lint" },
        tests: { ok: true, command: "npm test" },
        repairAttempts: 1,
      },
    });

    expect(body).toContain("## Task");
    expect(body).toContain("Add the helper and a test");
    expect(body).toContain("`src/index.js`");
    expect(body).toContain("Lint: passed");
    expect(body).toContain("Repair rounds used: 1");
    expect(body).toContain("openai/gpt-4o");
  });

  it("says plainly when a check was skipped rather than implying it passed", () => {
    const body = buildPrBody({
      task: "t",
      model: "m",
      files: [],
      verification: { lint: { skipped: true }, tests: { skipped: true } },
    });
    expect(body).toContain("skipped (no command configured)");
  });
});
