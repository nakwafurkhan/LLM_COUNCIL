/**
 * Codebase awareness.
 *
 * Closes limitation #2: the model previously saw only the task text, so it
 * invented imports, ignored the project's module system, and wrote tests in a
 * framework the repo does not use.
 *
 * The context pack is assembled in a documented priority order and truncated
 * against a token budget, so a large repo degrades by dropping the least
 * relevant material rather than by blowing the context window.
 *
 * Priority, highest first:
 *   1. Target files in full — the model is editing these.
 *   2. package.json and detected conventions.
 *   3. Config files (eslint, prettier, tsconfig, vitest/jest).
 *   4. Related files found by symbol/import search.
 *   5. The repo tree.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { estimateTokens } from "../../lib/tokenCost.js";
import { assertInsideRepo } from "./paths.js";

const execFileAsync = promisify(execFile);

const CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  ".prettierrc",
  ".prettierrc.json",
  "vitest.config.js",
  "jest.config.js",
  "vite.config.js",
];

/** Files never worth sending to a model. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "vendor",
]);

/** List tracked files, which respects .gitignore for free. */
export async function repoTree(repoRoot, { limit = 500 } = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean).slice(0, limit);
  } catch {
    // Not a git repo (or git unavailable): walk the tree instead.
    return walk(repoRoot, repoRoot, limit);
  }
}

async function walk(root, dir, limit, acc = []) {
  if (acc.length >= limit) return acc;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (acc.length >= limit) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, limit, acc);
    else acc.push(path.relative(root, full));
  }
  return acc;
}

/**
 * Infer the project's conventions from what is actually in the repo.
 *
 * Telling the model "this project uses ESM, double quotes, and vitest" is far
 * more effective than hoping it infers the same from a few file excerpts.
 */
export async function detectConventions(repoRoot) {
  const conventions = {
    moduleSystem: "unknown",
    packageManager: "npm",
    testFramework: "unknown",
    quoteStyle: "unknown",
    semicolons: "unknown",
    indent: "unknown",
  };

  const pkg = await readJson(path.join(repoRoot, "package.json"));
  if (pkg) {
    conventions.moduleSystem = pkg.type === "module" ? "esm" : "commonjs";
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) conventions.testFramework = "vitest";
    else if (deps.jest) conventions.testFramework = "jest";
    else if (deps.mocha) conventions.testFramework = "mocha";
    else if (pkg.scripts?.test?.includes("node --test"))
      conventions.testFramework = "node:test";
  }

  const prettier =
    (await readJson(path.join(repoRoot, ".prettierrc"))) ??
    (await readJson(path.join(repoRoot, ".prettierrc.json"))) ??
    pkg?.prettier;
  if (prettier) {
    conventions.quoteStyle = prettier.singleQuote ? "single" : "double";
    conventions.semicolons = prettier.semi === false ? "omitted" : "required";
    if (prettier.tabWidth) conventions.indent = `${prettier.tabWidth} spaces`;
  }

  return conventions;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Read a repo file, or null when it does not exist. */
export async function readRepoFile(repoRoot, relativePath) {
  try {
    const abs = assertInsideRepo(repoRoot, relativePath);
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Find files related to the task.
 *
 * Uses `git grep` for identifiers pulled out of the task text and from the
 * target files' imports. Not semantic search — but it reliably surfaces the
 * definition of a symbol the task names, which is the common case.
 */
export async function findRelatedFiles(repoRoot, { task, targetPaths = [], limit = 8 }) {
  const terms = new Set();

  // Identifiers from the task: CamelCase, snake_case, dotted calls.
  for (const match of String(task).matchAll(
    /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]{5,})\b/g,
  )) {
    terms.add(match[1]);
  }

  // Imports from the target files: their collaborators matter.
  for (const target of targetPaths) {
    const content = await readRepoFile(repoRoot, target);
    if (!content) continue;
    for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      if (spec.startsWith(".")) terms.add(path.basename(spec, path.extname(spec)));
    }
  }

  const found = new Map();
  for (const term of Array.from(terms).slice(0, 12)) {
    if (found.size >= limit) break;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["grep", "-l", "--fixed-strings", "--", term],
        { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      );
      for (const file of stdout.split("\n").filter(Boolean)) {
        if (targetPaths.includes(file)) continue;
        if (found.size >= limit) break;
        found.set(file, (found.get(file) ?? 0) + 1);
      }
    } catch {
      // `git grep` exits non-zero when nothing matches; that is not an error.
    }
  }

  // Most-referenced first: a file matching several task terms is likelier to
  // be the one the task is actually about.
  return Array.from(found.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file]) => file);
}

/**
 * Assemble the context pack.
 *
 * @returns {Promise<{text: string, tokens: number, included: string[], dropped: string[]}>}
 */
export async function buildContextPack(
  repoRoot,
  { task, targetPaths = [], tokenBudget = 60_000 },
) {
  const sections = [];
  const included = [];
  const dropped = [];
  let tokens = 0;

  const add = (label, body, sourcePath) => {
    const block = `\n### ${label}\n\`\`\`\n${body}\n\`\`\`\n`;
    const cost = estimateTokens(block);
    if (tokens + cost > tokenBudget) {
      if (sourcePath) dropped.push(sourcePath);
      return false;
    }
    sections.push(block);
    tokens += cost;
    if (sourcePath) included.push(sourcePath);
    return true;
  };

  // 1. Conventions — cheap and high value, so never dropped.
  const conventions = await detectConventions(repoRoot);
  add("Project conventions", JSON.stringify(conventions, null, 2));

  // 2. Target files in full.
  for (const target of targetPaths) {
    const content = await readRepoFile(repoRoot, target);
    add(`Target file: ${target}`, content ?? "(does not exist yet — will be created)", target);
  }

  // 3. Config files.
  for (const file of CONFIG_FILES) {
    const content = await readRepoFile(repoRoot, file);
    if (content) add(`Config: ${file}`, truncate(content, 4_000), file);
  }

  // 4. Related files.
  const related = await findRelatedFiles(repoRoot, { task, targetPaths });
  for (const file of related) {
    const content = await readRepoFile(repoRoot, file);
    if (content) add(`Related file: ${file}`, truncate(content, 6_000), file);
  }

  // 5. The tree, last: useful orientation, but the least dense information.
  const tree = await repoTree(repoRoot);
  add("Repository tree", tree.join("\n"));

  return { text: sections.join("\n"), tokens, included, dropped, conventions, related };
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}
