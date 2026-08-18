/**
 * Render smoke test — `npm run smoke`
 *
 * Server-renders the real App to catch what `vite build` cannot: bad component
 * references, invalid hook usage, undefined props. Deliberately not a test
 * framework — it needs no vitest, no jsdom, and runs in about a second.
 *
 * It proves the app renders. It does not prove interactions work.
 */
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
globalThis.window = { innerWidth: 1280 };
// node 24 defines navigator as a getter-only global; patch the property instead
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText() {} } },
    configurable: true,
  });
} catch (err) { /* fine — App only touches it in a click handler */ }

import React from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from './src/App.jsx';

const html = renderToString(React.createElement(App));

const checks = [
  ['sidebar renders', html.includes('New conversation')],
  ['all five modes present', ['Chat', 'Quick', 'Council', 'Code + PR', 'Humanize']
    .every((m) => html.includes(m))],
  ['composer renders', html.includes('Ask anything')],
  ['empty state renders', html.includes('straight conversation with one model')],
  ['model picker renders', html.includes('picker-btn')],
  ['history section renders', html.includes('History')],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
console.log(`\n  rendered ${html.length} bytes of HTML`);
process.exit(ok ? 0 : 1);
