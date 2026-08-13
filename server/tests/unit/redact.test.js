/**
 * The redaction guarantee.
 *
 * If any of these fail, a secret can reach a log line or an API response.
 * Treat a failure here as a security regression, not a flaky test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  redact,
  redactString,
  redactedJson,
  registerSecret,
  registerSecretsFromConfig,
  clearSecrets,
  REDACTED,
} from "../../src/lib/redact.js";

const MESH_KEY = "rsk_live_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c";
const GH_TOKEN = "ghp_ABCdef1234567890ABCdef1234567890abcd";

beforeEach(() => clearSecrets());

describe("redactString", () => {
  it("scrubs a registered literal secret anywhere in the text", () => {
    registerSecret(MESH_KEY);
    const out = redactString(`Authorization failed for key ${MESH_KEY} on retry 2`);
    expect(out).not.toContain(MESH_KEY);
    expect(out).toContain(REDACTED);
    expect(out).toContain("on retry 2");
  });

  it("scrubs secrets by shape even when never registered", () => {
    // The whole point: a key we were never handed, echoed back by an upstream.
    expect(redactString(`unexpected token ${MESH_KEY}`)).not.toContain(MESH_KEY);
    expect(redactString(`remote: ${GH_TOKEN}`)).not.toContain(GH_TOKEN);
    expect(redactString("github_pat_11ABCDEFG0abcdefghijkl_XYZ")).toContain(REDACTED);
    expect(redactString("sk-proj-abcdefghijklmnopqrstuvwxyz")).toContain(REDACTED);
  });

  it("keeps the bearer prefix but drops the credential", () => {
    const out = redactString("Authorization: Bearer eyJhbGciOi.JIUzI1NiIs.InR5cCI6IkpXVCJ9");
    expect(out).toMatch(/Bearer \[REDACTED\]/);
    expect(out).not.toContain("eyJhbGciOi");
  });

  it("drops a mongodb password while keeping the host readable", () => {
    const out = redactString("mongodb+srv://appuser:sup3rs3cret@cluster0.abcde.mongodb.net/db");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("cluster0.abcde.mongodb.net");
    expect(out).toContain("appuser");
  });

  it("leaves ordinary text alone", () => {
    const text = "Council run completed in 4200ms with 3 members";
    expect(redactString(text)).toBe(text);
  });

  it("ignores short registrations that would mangle unrelated text", () => {
    registerSecret("abc");
    expect(redactString("abc is a normal word fragment")).toBe("abc is a normal word fragment");
  });
});

describe("redact (deep)", () => {
  it("drops values under sensitive keys regardless of content", () => {
    const out = redact({
      authorization: "Bearer whatever",
      GITHUB_TOKEN: "anything at all",
      password: "hunter2",
      model: "openai/gpt-4o",
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out.GITHUB_TOKEN).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("recurses through nested objects and arrays", () => {
    registerSecret(MESH_KEY);
    const out = redact({
      run: { members: [{ error: `401 from provider: ${MESH_KEY}` }] },
    });
    expect(JSON.stringify(out)).not.toContain(MESH_KEY);
  });

  it("scrubs Error messages and stacks without losing the type", () => {
    registerSecret(MESH_KEY);
    const err = new Error(`request failed with key ${MESH_KEY}`);
    const out = redact(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).not.toContain(MESH_KEY);
    expect(out.stack ?? "").not.toContain(MESH_KEY);
  });

  it("survives circular references", () => {
    const node = { name: "a" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect(redact(node).self).toBe("[Circular]");
  });

  it("passes primitives through untouched", () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(true)).toBe(true);
  });
});

describe("the guarantee", () => {
  it("neither MESH_API_KEY nor GITHUB_TOKEN survives serialisation", () => {
    registerSecretsFromConfig({ MESH_API_KEY: MESH_KEY, GITHUB_TOKEN: GH_TOKEN });

    // A deliberately hostile payload: secrets in values, in nested errors,
    // in array members, in interpolated prose, and under innocuous key names.
    const payload = {
      config: { MESH_API_KEY: MESH_KEY, GITHUB_TOKEN: GH_TOKEN },
      note: `pushing with ${GH_TOKEN} using ${MESH_KEY}`,
      attempts: [
        { detail: `retry after 401: ${MESH_KEY}` },
        { innocuous: `git remote set-url origin https://${GH_TOKEN}@github.com/o/r.git` },
      ],
      err: new Error(`upstream rejected ${MESH_KEY}`),
    };

    const serialised = redactedJson(payload);
    expect(serialised).not.toContain(MESH_KEY);
    expect(serialised).not.toContain(GH_TOKEN);
    expect(serialised).toContain(REDACTED);
  });
});
