/**
 * Secret scrubbing.
 *
 * Two independent layers, because either one alone has a gap:
 *
 *  1. **Known values.** Whatever is actually in MESH_API_KEY / GITHUB_TOKEN is
 *     registered at boot and replaced wherever it appears. Catches secrets that
 *     don't match any pattern.
 *  2. **Known shapes.** Regexes for `rsk_…`, `ghp_…`, `github_pat_…`, `sk-…`,
 *     bearer headers. Catches secrets we were never told about — a key pasted
 *     into a prompt, or a token echoed back inside an upstream error body.
 *
 * Applied to every log line (via pino's formatter) and to every error message
 * that can reach a response. Tested in tests/unit/redact.test.js.
 */

export const REDACTED = "[REDACTED]";

/** Literal secret values registered at boot. */
const knownSecrets = new Set();

/**
 * Patterns for secrets we may never have been handed directly.
 * Ordered longest-prefix-first so `github_pat_` wins over a generic match.
 */
const SECRET_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgho_[A-Za-z0-9]{16,}\b/g,
  /\bghs_[A-Za-z0-9]{16,}\b/g,
  /\brsk_[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  // Authorization: Bearer <anything>
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // mongodb://user:password@host -> keep the shape, drop the password
  /(mongodb(?:\+srv)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi,
];

/** Header and field names whose values are always dropped. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "api_key",
  "mesh_api_key",
  "meshapikey",
  "github_token",
  "githubtoken",
  "token",
  "password",
  "secret",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/**
 * Register a literal secret so it is scrubbed wherever it appears.
 * Short values are ignored — redacting a 3-character string would mangle
 * unrelated text.
 */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) knownSecrets.add(value);
}

/** Test seam. */
export function clearSecrets() {
  knownSecrets.clear();
}

/** Register every secret-bearing field from a parsed config. */
export function registerSecretsFromConfig(config) {
  registerSecret(config?.MESH_API_KEY);
  registerSecret(config?.GITHUB_TOKEN);
  return config;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scrub a single string. */
export function redactString(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;

  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // Patterns with capture groups keep their non-secret prefix/suffix.
      const captured = groups.slice(0, -2).filter((g) => typeof g === "string");
      if (captured.length === 1) return `${captured[0]}${REDACTED}`;
      if (captured.length === 2) return `${captured[0]}${REDACTED}${captured[1]}`;
      return REDACTED;
    });
  }
  return out;
}

/**
 * Deep-scrub any value: strings, arrays, plain objects, Errors, Maps, Sets.
 * Cycles are handled. Non-serialisable values are passed through untouched.
 */
export function redact(value, seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const clone = new Error(redactString(value.message));
    clone.name = value.name;
    if (value.stack) clone.stack = redactString(value.stack);
    for (const key of Object.keys(value)) {
      if (key === "message" || key === "stack") continue;
      clone[key] = redact(value[key], seen);
    }
    return clone;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value, ([k, v]) => [
        k,
        SENSITIVE_KEYS.has(String(k).toLowerCase()) ? REDACTED : redact(v, seen),
      ]),
    );
  }
  if (value instanceof Set) return Array.from(value, (v) => redact(v, seen));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(val, seen);
  }
  return out;
}

/** Convenience: scrub then JSON-stringify. */
export function redactedJson(value, space) {
  return JSON.stringify(redact(value), null, space);
}
