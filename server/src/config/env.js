/**
 * Validated configuration.
 *
 * Every knob the app reads lives here, is described by a Zod schema, and is
 * checked once at boot. Nothing else in the codebase may read `process.env`
 * directly — that rule is what stopped the old `MESHAPI_KEY` / `MESH_API_KEY`
 * drift from being detectable.
 *
 * On bad config this throws with the exact variable names at fault, so the
 * failure names the fix rather than surfacing as a null-deref three layers in.
 */
import { z } from "zod";

/** Comma-separated string -> trimmed, non-empty array. */
const csv = (fallback) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );

const boolish = (fallback) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

export const envSchema = z
  .object({
    /* --- Required --- */
    MESH_API_KEY: z
      .string({ required_error: "MESH_API_KEY is required" })
      .min(1, "MESH_API_KEY must not be empty"),
    MONGODB_URI: z
      .string({ required_error: "MONGODB_URI is required" })
      .refine(
        (v) => v.startsWith("mongodb://") || v.startsWith("mongodb+srv://"),
        "MONGODB_URI must start with mongodb:// or mongodb+srv://",
      ),

    /* --- Core --- */
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: port.default(8787),
    MONGODB_DB: z.string().default("llm_council"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CORS_ORIGINS: csv("http://localhost:5173"),

    /* --- Upstream provider --- */
    MESH_BASE_URL: z.string().url().default("https://api.meshapi.ai/v1"),
    MESH_TIMEOUT_MS: positiveInt.default(120_000),
    MESH_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    /* --- Models --- */
    CHAT_MODEL: z.string().default("openai/gpt-4o"),
    QUICK_MODEL: z.string().default("openai/gpt-4o-mini"),
    COUNCIL_MODELS: csv("openai/gpt-4o,openai/gpt-4o-mini,anthropic/claude-3-5-sonnet"),
    CHAIRMAN_MODEL: z.string().default("openai/gpt-4o"),
    CODE_MODEL: z.string().default("openai/gpt-4o"),
    /**
     * Extra ids a client may request beyond the ones named above. The
     * effective allowlist is this plus every configured model — a raw
     * client-supplied string is never passed upstream.
     */
    EXTRA_ALLOWED_MODELS: csv(""),

    /* --- Chat / Quick tuning --- */
    CHAT_MAX_TOKENS: positiveInt.default(4_096),
    QUICK_MAX_TOKENS: positiveInt.default(1_024),
    QUICK_TIMEOUT_MS: positiveInt.default(30_000),
    CHAT_CONTEXT_WINDOW: positiveInt.default(20),
    CHAT_SUMMARY_TRIGGER: positiveInt.default(30),

    /* --- Council --- */
    COUNCIL_MEMBER_TIMEOUT_MS: positiveInt.default(60_000),
    COUNCIL_MAX_CONCURRENCY: positiveInt.default(3),
    COUNCIL_CACHE_TTL_MS: z.coerce.number().int().min(0).default(600_000),

    /* --- Code + PR --- */
    REPO_LOCAL_PATH: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_OWNER: z.string().optional(),
    GITHUB_REPO: z.string().optional(),
    BASE_BRANCH: z.string().default("main"),
    PR_MAX_FILES: positiveInt.default(20),
    PR_LINT_CMD: z.string().optional(),
    PR_TEST_CMD: z.string().optional(),
    PR_VERIFY_TIMEOUT_MS: positiveInt.default(300_000),
    PR_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
    PR_AUTO_APPROVE: boolish("false"),
    PR_CONTEXT_TOKEN_BUDGET: positiveInt.default(60_000),

    /* --- Rate limiting --- */
    RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
    RATE_LIMIT_MAX: positiveInt.default(120),
    RATE_LIMIT_COUNCIL_MAX: positiveInt.default(10),
    RATE_LIMIT_PR_MAX: positiveInt.default(5),

    /* --- Testing --- */
    /** When true the fake LLM adapter is used. Set by the test harness and E2E. */
    USE_FAKE_LLM: boolish("false"),
    BODY_LIMIT: z.string().default("1mb"),
  })
  .transform((cfg) => ({
    ...cfg,
    isProduction: cfg.NODE_ENV === "production",
    isTest: cfg.NODE_ENV === "test",
    /**
     * Every model id the server will accept, deduped. Client-supplied ids are
     * checked against this set; anything else is a 400, not an upstream call.
     */
    allowedModels: Array.from(
      new Set([
        cfg.CHAT_MODEL,
        cfg.QUICK_MODEL,
        cfg.CHAIRMAN_MODEL,
        cfg.CODE_MODEL,
        ...cfg.COUNCIL_MODELS,
        ...cfg.EXTRA_ALLOWED_MODELS,
      ]),
    ),
  }));

/**
 * Parse an environment object into config.
 *
 * @param {Record<string, string|undefined>} source
 * @returns {ReturnType<typeof envSchema.parse>}
 * @throws {Error} with every offending variable named, one per line.
 */
export function loadConfig(source = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\nSee .env.example for the full reference.`,
    );
  }

  return result.data;
}

let cached = null;

/** Process-wide config, parsed on first use. */
export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: drop the memoised config so a new env can be loaded. */
export function resetConfig() {
  cached = null;
}
