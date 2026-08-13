/**
 * E2E configuration.
 *
 * Runs against the real server with the fake LLM adapter on one origin, so
 * these specs exercise the actual streaming wire format rather than a mock.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? 8788;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The client must be built first; the server serves it from server/public.
    command: "npm run build && node e2e/server.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
