/**
 * Settings are mirrored to the server so a second device inherits your setup.
 * The Mesh key must never make that trip. The client omits it; this strips it
 * again on arrival, including any value that merely looks like a key.
 */
const SECRET_FIELDS = new Set(['apikey', 'api_key', 'key', 'token', 'secret', 'authorization']);
const SECRET_SHAPE = /^(rsk_|sk-|ghp_|xox[baprs]-)/i;

export function scrubSecrets(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_FIELDS.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && SECRET_SHAPE.test(v.trim())) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = scrubSecrets(v); continue; }
    out[k] = v;
  }
  return out;
}
