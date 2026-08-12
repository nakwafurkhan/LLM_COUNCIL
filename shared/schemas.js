/**
 * Single source of truth for request/response shapes.
 *
 * Imported by BOTH the Express routes (via the `validate` middleware) and the
 * React client (via api/client.js). Keeping one copy is what stops the two
 * sides drifting apart the way the old browser-side `messages` array did.
 *
 * Nothing in here may import from `server/` or `client/`.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const MODES = ["chat", "quick"];
export const ROLES = ["system", "user", "assistant"];

/** Mongo ObjectId as it appears over the wire. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "must be a 24-character hex id");

/**
 * A model identifier such as `openai/gpt-4o`.
 *
 * Shape validation only. Whether a given id is *permitted* is decided
 * server-side against the allowlist in config — never trust the client here.
 */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w.-]+\/[\w.:-]+$/, "expected `provider/model` form");

export const modeSchema = z.enum(MODES);
export const roleSchema = z.enum(ROLES);

/** Upper bound on any single user-authored prompt, in characters. */
export const MAX_PROMPT_CHARS = 32_000;

export const promptTextSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(MAX_PROMPT_CHARS, `must be at most ${MAX_PROMPT_CHARS} characters`);

/* ------------------------------------------------------------------ */
/* Chat + Quick                                                        */
/* ------------------------------------------------------------------ */

export const createConversationSchema = z.object({
  mode: modeSchema.default("chat"),
  title: z.string().trim().max(200).optional(),
  model: modelIdSchema.optional(),
});

export const listConversationsQuerySchema = z.object({
  mode: modeSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: objectIdSchema.optional(),
});

export const postMessageSchema = z.object({
  content: promptTextSchema,
  model: modelIdSchema.optional(),
  stream: z.boolean().default(true),
});

export const regenerateMessageSchema = z.object({
  model: modelIdSchema.optional(),
  stream: z.boolean().default(true),
});

export const editMessageSchema = z.object({
  content: promptTextSchema,
  stream: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* Council                                                             */
/* ------------------------------------------------------------------ */

export const councilRequestSchema = z.object({
  prompt: promptTextSchema,
  models: z.array(modelIdSchema).min(1).max(8).optional(),
  chairmanModel: modelIdSchema.optional(),
  stream: z.boolean().default(true),
  bypassCache: z.boolean().default(false),
});

/**
 * The structured object the chairman is asked to return.
 *
 * Parsed defensively: when the model returns prose instead of JSON we fall
 * back to treating the whole response as `answer` with no disagreements,
 * rather than failing the run.
 */
export const disagreementSchema = z.object({
  claim: z.string().min(1),
  positions: z
    .array(
      z.object({
        model: z.string().min(1),
        stance: z.string().min(1),
      }),
    )
    .default([]),
});

export const chairmanOutputSchema = z.object({
  answer: z.string().min(1),
  disagreements: z.array(disagreementSchema).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  confidenceNote: z.string().default(""),
});

export const councilHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: objectIdSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Code + PR                                                           */
/* ------------------------------------------------------------------ */

export const PR_STATUSES = [
  "queued",
  "planning",
  "generating",
  "verifying",
  "awaiting_approval",
  "pushing",
  "completed",
  "failed",
  "cancelled",
];

export const prStatusSchema = z.enum(PR_STATUSES);

/**
 * A repo-relative path.
 *
 * This is shape validation, not a security boundary — the real containment
 * check is `assertInsideRepo()` in services/codePR/paths.js, which resolves
 * against REPO_LOCAL_PATH. Both must pass.
 */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith("/"), "must be repo-relative, not absolute")
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), "must not contain `..` segments")
  .refine((p) => !p.includes("\0"), "must not contain null bytes");

export const createPrJobSchema = z.object({
  task: z.string().trim().min(10, "describe the task in at least 10 characters").max(8_000),
  targetPaths: z.array(repoPathSchema).max(50).default([]),
  branch: z.string().trim().max(200).optional(),
  baseBranch: z.string().trim().max(200).optional(),
  model: modelIdSchema.optional(),
});

/** The plan the planner model must return, before any file is touched. */
export const planFileSchema = z.object({
  path: repoPathSchema,
  action: z.enum(["create", "modify", "delete"]),
  reason: z.string().min(1).max(2_000),
});

export const planSchema = z.object({
  summary: z.string().min(1).max(4_000),
  files: z.array(planFileSchema).min(1),
  notes: z.string().max(4_000).default(""),
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Every non-2xx response from the API has this shape. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
