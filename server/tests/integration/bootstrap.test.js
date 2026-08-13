/**
 * Startup failures.
 *
 * These spawn the real bootstrap as a child process, because the behaviour
 * under test is what the process prints and what exit code it returns — not
 * something a unit test of an exported function can observe.
 *
 * The bug this guards against: a busy port used to reach the uncaughtException
 * handler, logging a FATAL with a stack trace, and the shutdown path then
 * called close() on a server that had never bound, adding a second misleading
 * ERR_SERVER_NOT_RUNNING. Two alarming errors for a condition whose fix is one
 * line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import mongoose from "mongoose";

const entry = path.resolve(import.meta.dirname, "../../src/index.js");
const OCCUPIED_PORT = 8899;

let squatter;

beforeAll(async () => {
  // Hold the port so the bootstrap is guaranteed to hit EADDRINUSE.
  squatter = http.createServer(() => {});
  await new Promise((resolve) => squatter.listen(OCCUPIED_PORT, resolve));
});

afterAll(async () => {
  await new Promise((resolve) => squatter.close(resolve));
});

/**
 * Run the bootstrap and collect everything it emitted.
 * The integration setup already has an in-memory Mongo running; reuse its URI
 * so the process gets far enough to attempt a listen.
 */
function runBootstrap(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        MESH_API_KEY: "rsk_bootstrap_test_000000",
        MONGODB_URI: mongoose.connection.client.s.url ?? "mongodb://127.0.0.1:27017",
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));

    const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, output });
    });
  });
}

describe("a port that is already in use", () => {
  it("exits with one actionable message and no stack trace", async () => {
    const { code, output } = await runBootstrap({ PORT: String(OCCUPIED_PORT) });

    expect(code).toBe(1);
    expect(output).toContain(`Port ${OCCUPIED_PORT} is already in use`);
    // The message has to tell you how to fix it, not just what happened.
    expect(output).toMatch(/lsof -ti:8899/);
    expect(output).toMatch(/PORT=8788/);

    // The two symptoms of the old behaviour.
    expect(output).not.toContain("uncaught exception");
    expect(output).not.toContain("ERR_SERVER_NOT_RUNNING");
    expect(output).not.toContain("Server is not running");
  }, 30_000);

  it("does not print a FATAL for an ordinary busy port", async () => {
    const { output } = await runBootstrap({ PORT: String(OCCUPIED_PORT) });
    // A port conflict is a normal local-dev condition, not a crash.
    expect(output).not.toMatch(/FATAL/i);
  }, 30_000);
});

describe("a privileged port", () => {
  it("explains that the port needs elevated privileges", async () => {
    // Root would actually bind port 80, so the assertion has to accept either
    // the EACCES message or a successful start.
    const { output } = await runBootstrap({ PORT: "80" });
    if (output.includes("Not allowed to bind")) {
      expect(output).toMatch(/above\n1024|above 1024/);
    } else {
      expect(output).toMatch(/listening|already in use/);
    }
  }, 30_000);
});

describe("a usable port", () => {
  it("starts and reports the port it bound", async () => {
    const { output } = await runBootstrap({ PORT: "8901" });
    expect(output).toContain("llm-council listening");
    expect(output).toContain("8901");
  }, 30_000);
});
