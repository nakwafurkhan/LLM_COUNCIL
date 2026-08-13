/**
 * Config validation.
 *
 * The old server.js read MESHAPI_KEY while .env.example documented
 * MESH_API_KEY — a drift that only showed up as a boot-time exit with a
 * misleading message. These tests pin the contract: one spelling, and a
 * failure that names the variable at fault.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";

import { loadConfig, envFileCandidates } from "../../src/config/env.js";

/** Minimum viable environment. */
const base = {
  MESH_API_KEY: "rsk_test_key_value_1234567890",
  MONGODB_URI: "mongodb://localhost:27017",
};

describe("required variables", () => {
  it("accepts a minimal valid environment", () => {
    const cfg = loadConfig(base);
    expect(cfg.MESH_API_KEY).toBe(base.MESH_API_KEY);
    expect(cfg.PORT).toBe(8787);
    expect(cfg.NODE_ENV).toBe("development");
  });

  it("rejects a missing MESH_API_KEY and names it", () => {
    expect(() => loadConfig({ MONGODB_URI: base.MONGODB_URI })).toThrowError(/MESH_API_KEY/);
  });

  it("rejects an empty MESH_API_KEY", () => {
    expect(() => loadConfig({ ...base, MESH_API_KEY: "" })).toThrowError(/MESH_API_KEY/);
  });

  it("does not accept the old MESHAPI_KEY spelling", () => {
    // The whole point of standardising: the legacy name must not satisfy the
    // requirement, or a stale deploy would boot and fail later at runtime.
    expect(() =>
      loadConfig({ MESHAPI_KEY: "rsk_legacy_name", MONGODB_URI: base.MONGODB_URI }),
    ).toThrowError(/MESH_API_KEY/);
  });

  it("rejects a missing MONGODB_URI and names it", () => {
    expect(() => loadConfig({ MESH_API_KEY: base.MESH_API_KEY })).toThrowError(/MONGODB_URI/);
  });

  it("rejects a MONGODB_URI with the wrong scheme", () => {
    expect(() =>
      loadConfig({ ...base, MONGODB_URI: "postgres://localhost:5432" }),
    ).toThrowError(/MONGODB_URI/);
  });

  it("accepts both mongodb:// and mongodb+srv://", () => {
    expect(loadConfig({ ...base, MONGODB_URI: "mongodb://h:27017" })).toBeTruthy();
    expect(
      loadConfig({ ...base, MONGODB_URI: "mongodb+srv://u:p@c.mongodb.net" }),
    ).toBeTruthy();
  });

  it("reports every problem at once rather than one per boot", () => {
    // Fixing config one restart at a time is miserable; list them all.
    try {
      loadConfig({ PORT: "not-a-number" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.message).toMatch(/MESH_API_KEY/);
      expect(err.message).toMatch(/MONGODB_URI/);
      expect(err.message).toMatch(/PORT/);
    }
  });
});

describe("coercion and defaults", () => {
  it("coerces numeric strings to numbers", () => {
    const cfg = loadConfig({ ...base, PORT: "3000", MESH_TIMEOUT_MS: "5000" });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.MESH_TIMEOUT_MS).toBe(5000);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => loadConfig({ ...base, PORT: "0" })).toThrowError(/PORT/);
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrowError(/PORT/);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => loadConfig({ ...base, MESH_TIMEOUT_MS: "0" })).toThrowError(/MESH_TIMEOUT_MS/);
  });

  it("splits comma-separated lists and trims whitespace", () => {
    const cfg = loadConfig({
      ...base,
      COUNCIL_MODELS: "openai/gpt-4o, anthropic/claude-3-5-sonnet ,  google/gemini-1.5-pro",
      CORS_ORIGINS: "http://localhost:5173,https://example.com",
    });
    expect(cfg.COUNCIL_MODELS).toEqual([
      "openai/gpt-4o",
      "anthropic/claude-3-5-sonnet",
      "google/gemini-1.5-pro",
    ]);
    expect(cfg.CORS_ORIGINS).toHaveLength(2);
  });

  it("treats an empty list as empty, not as one blank entry", () => {
    expect(loadConfig({ ...base, EXTRA_ALLOWED_MODELS: "" }).EXTRA_ALLOWED_MODELS).toEqual([]);
  });

  it("parses booleans from the usual spellings", () => {
    expect(loadConfig({ ...base, PR_AUTO_APPROVE: "true" }).PR_AUTO_APPROVE).toBe(true);
    expect(loadConfig({ ...base, PR_AUTO_APPROVE: "1" }).PR_AUTO_APPROVE).toBe(true);
    expect(loadConfig({ ...base, PR_AUTO_APPROVE: "false" }).PR_AUTO_APPROVE).toBe(false);
    expect(loadConfig(base).PR_AUTO_APPROVE).toBe(false);
  });

  it("rejects a boolean it cannot interpret rather than guessing", () => {
    expect(() => loadConfig({ ...base, PR_AUTO_APPROVE: "yes" })).toThrowError(
      /PR_AUTO_APPROVE/,
    );
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "staging" })).toThrowError(/NODE_ENV/);
  });

  it("rejects a non-URL MESH_BASE_URL", () => {
    expect(() => loadConfig({ ...base, MESH_BASE_URL: "not a url" })).toThrowError(
      /MESH_BASE_URL/,
    );
  });
});

describe("derived values", () => {
  it("builds the model allowlist from every configured model", () => {
    const cfg = loadConfig({
      ...base,
      CHAT_MODEL: "openai/gpt-4o",
      QUICK_MODEL: "openai/gpt-4o-mini",
      COUNCIL_MODELS: "openai/gpt-4o,anthropic/claude-3-5-sonnet",
      EXTRA_ALLOWED_MODELS: "google/gemini-1.5-flash",
    });
    expect(cfg.allowedModels).toContain("openai/gpt-4o");
    expect(cfg.allowedModels).toContain("anthropic/claude-3-5-sonnet");
    expect(cfg.allowedModels).toContain("google/gemini-1.5-flash");
    // Deduped: gpt-4o is both the chat model and a council member.
    expect(cfg.allowedModels.filter((m) => m === "openai/gpt-4o")).toHaveLength(1);
  });

  it("exposes environment booleans", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production" }).isProduction).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: "test" }).isTest).toBe(true);
    expect(loadConfig(base).isProduction).toBe(false);
  });
});

describe("envFileCandidates", () => {
  // Regression guard. `npm run dev --workspace server` runs the server with
  // cwd set to server/, so a cwd-relative dotenv lookup misses the repo-root
  // .env entirely and the server dies insisting required variables are absent
  // when they are sitting in the file the docs told you to create.
  const serverSrc = path.resolve(import.meta.dirname, "../../src");

  it("looks in the repo root first", () => {
    const [first] = envFileCandidates(serverSrc);
    const repoRoot = path.resolve(serverSrc, "../..");
    expect(first).toBe(path.join(repoRoot, ".env"));
  });

  it("falls back to a per-package .env", () => {
    const [, second] = envFileCandidates(serverSrc);
    expect(second).toBe(path.join(path.resolve(serverSrc, ".."), ".env"));
  });

  it("returns absolute paths, so cwd cannot change the answer", () => {
    for (const candidate of envFileCandidates(serverSrc)) {
      expect(path.isAbsolute(candidate)).toBe(true);
    }
  });

  it("points at the directory that actually holds .env.example", () => {
    // The strongest form of the check: the root candidate must live beside the
    // template users are told to copy. If the layout moves, this fails.
    const [rootCandidate] = envFileCandidates(serverSrc);
    expect(fs.existsSync(path.join(path.dirname(rootCandidate), ".env.example"))).toBe(true);
  });
});
