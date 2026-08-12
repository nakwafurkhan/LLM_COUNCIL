/**
 * Test projects.
 *
 * Split so each tier can run alone in CI and fail fast:
 *   unit        — pure logic. No Mongo, no network, no Express.
 *   integration — real Express app + mongodb-memory-server + fake LLM adapter.
 *   client      — React Testing Library under jsdom.
 *
 * E2E lives in Playwright (playwright.config.js), not here.
 *
 * Coverage thresholds are the gate the brief asks for: 85% on services and
 * routes, 70% overall. CI fails below either.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          root: "./server",
          include: ["tests/unit/**/*.test.js"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          root: "./server",
          include: ["tests/integration/**/*.test.js"],
          environment: "node",
          // Mongo-backed suites share one memory server; running files in
          // parallel against it causes cross-test bleed.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          setupFiles: ["./tests/setup/integration.setup.js"],
        },
      },
      {
        // The React plugin supplies the automatic JSX runtime. Without it
        // every component test fails with "React is not defined", since the
        // source deliberately does not import React on every file.
        plugins: [react()],
        test: {
          name: "client",
          root: "./client",
          include: ["tests/**/*.test.jsx"],
          environment: "jsdom",
          setupFiles: ["./tests/setup.js"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["server/src/**/*.js", "client/src/**/*.{js,jsx}"],
      exclude: [
        // Bootstrap: opens ports and talks to the real world by definition.
        "server/src/index.js",
        "client/src/main.jsx",
        "**/node_modules/**",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
        "server/src/services/**/*.js": {
          lines: 85,
          functions: 85,
          statements: 85,
          branches: 75,
        },
        "server/src/routes/**/*.js": {
          lines: 85,
          functions: 85,
          statements: 85,
          branches: 75,
        },
      },
    },
  },
});
