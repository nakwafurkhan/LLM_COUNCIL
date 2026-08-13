/**
 * Planning and generation.
 *
 * Closes limitation #1: the old flow could only rewrite one file, so any task
 * spanning a module and its test was impossible. Now the model first returns a
 * structured plan naming every file to create, modify or delete, and each
 * file is then generated with the plan and its siblings in view — which is
 * what keeps a multi-file change internally consistent.
 *
 * The plan is validated against a Zod schema BEFORE anything touches the
 * filesystem. A malformed plan is a rejected request, not a half-written repo.
 */
import { planSchema } from "../../../../shared/schemas.js";
import { ValidationError } from "../../lib/errors.js";
import { assertInsideRepo } from "./paths.js";
import { readRepoFile } from "./context.js";

const PLANNER_SYSTEM = `You are a senior engineer planning a code change.

Given a task and a context pack describing the repository, decide exactly which files must be created, modified, or deleted.

Rules:
- Include every file the change requires, including tests and any config that must change. A change that breaks the build because you forgot a file is a failed change.
- Do not include files you do not intend to touch.
- Paths must be repo-relative. Never absolute, never containing "..".
- Prefer modifying existing files over creating parallel ones.

Respond with ONLY a JSON object:
{
  "summary": "what you are going to do and why",
  "files": [ { "path": "src/thing.js", "action": "create" | "modify" | "delete", "reason": "why this file" } ],
  "notes": "anything the implementer should know"
}`;

const GENERATOR_SYSTEM = `You are a senior engineer writing the full contents of one file.

You are given the overall plan, the other files being changed alongside it, and the project's conventions. Match the conventions exactly — module system, quote style, semicolons, test framework.

Respond with ONLY the complete file contents. No markdown fences, no commentary, no explanation before or after. The output is written to disk verbatim.`;

/** Strip fences a model added despite being asked not to. */
export function stripCodeFences(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : trimmed;
}

/** Parse and validate a plan. Throws ValidationError on anything unusable. */
export function parsePlan(raw) {
  const text = String(raw ?? "").trim();

  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = planSchema.safeParse(parsed);
    if (result.success) return result.data;

    // Well-formed JSON of the wrong shape is a real planner failure, and the
    // field errors are worth surfacing rather than retrying blindly.
    throw new ValidationError(
      "The planner returned JSON that is not a valid plan",
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }

  throw new ValidationError("The planner did not return a parseable JSON plan", [
    { path: "plan", message: "no JSON object found in the model response" },
  ]);
}

/**
 * Validate a plan against the repo and policy.
 * Runs before generation, so a bad plan costs one call rather than N.
 */
export function validatePlanAgainstRepo(plan, { repoRoot, maxFiles }) {
  if (plan.files.length > maxFiles) {
    throw new ValidationError(
      `Plan touches ${plan.files.length} files, over the limit of ${maxFiles}`,
      [{ path: "files", message: `at most ${maxFiles} files per job` }],
    );
  }

  const seen = new Set();
  for (const file of plan.files) {
    // Throws if the path escapes the repo by any route.
    assertInsideRepo(repoRoot, file.path);
    if (seen.has(file.path)) {
      throw new ValidationError(`Plan lists ${file.path} more than once`, [
        { path: "files", message: "duplicate path" },
      ]);
    }
    seen.add(file.path);
  }

  return plan;
}

export function createPlanner({ config, llm }) {
  /** Ask the model for a plan. */
  async function plan({ task, targetPaths, contextPack, model, repoRoot }) {
    const targetNote = targetPaths.length
      ? `The user named these target paths: ${targetPaths.join(", ")}. Treat them as the starting point, not necessarily the complete set.`
      : "The user named no target paths; work out which files are involved from the context.";

    const { content } = await llm.askModel({
      model,
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        {
          role: "user",
          content: `## Task\n${task}\n\n${targetNote}\n\n## Repository context\n${contextPack.text}`,
        },
      ],
      maxTokens: 2_048,
      responseFormat: { type: "json_object" },
    });

    return validatePlanAgainstRepo(parsePlan(content), {
      repoRoot,
      maxFiles: config.PR_MAX_FILES,
    });
  }

  /**
   * Generate the new contents for one file.
   *
   * The other planned files are described (not dumped in full) so the model
   * knows what its siblings are becoming without paying for every byte.
   */
  async function generateFile({
    task,
    plan: thePlan,
    file,
    repoRoot,
    contextPack,
    model,
    repairContext,
  }) {
    const existing = await readRepoFile(repoRoot, file.path);

    const siblings = thePlan.files
      .filter((f) => f.path !== file.path)
      .map((f) => `- ${f.path} (${f.action}): ${f.reason}`)
      .join("\n");

    const messages = [
      { role: "system", content: GENERATOR_SYSTEM },
      {
        role: "user",
        content: [
          `## Task\n${task}`,
          `## Plan\n${thePlan.summary}`,
          siblings ? `## Other files in this change\n${siblings}` : "",
          `## Conventions\n${JSON.stringify(contextPack.conventions, null, 2)}`,
          existing
            ? `## Current contents of ${file.path}\n\`\`\`\n${existing}\n\`\`\``
            : `## ${file.path} does not exist yet; write it from scratch.`,
          repairContext
            ? `## A previous attempt failed verification\nFix the problem described below. Do not restate it, just return corrected file contents.\n\n${repairContext}`
            : "",
          `## Now write the complete new contents of ${file.path}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const { content } = await llm.askModel({
      model,
      messages,
      maxTokens: config.CHAT_MAX_TOKENS,
    });

    return stripCodeFences(content);
  }

  return { plan, generateFile };
}
