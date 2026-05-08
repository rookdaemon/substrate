import { PiCliBackend } from "../../src/code-dispatch/PiCliBackend";
import type { IProcessRunner } from "../../src/agents/claude/IProcessRunner";
import type { IClock } from "../../src/substrate/abstractions/IClock";

describe("PiCliBackend", () => {
  const makeRunner = (exitCode: number, stdout: string, stderr = ""): IProcessRunner => ({
    async run() {
      return { exitCode, stdout, stderr };
    },
  });

  const makeClock = (time = new Date("2026-05-08T00:00:00Z")): IClock => ({
    now() {
      return time;
    },
  });

  it("routes to pi with provider, model, env, no-session, and bounded defaults", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts?: unknown }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        return { exitCode: 0, stdout: "ok" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock(), {
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6:floor",
      thinking: "off",
      sessionDir: "/tmp/pi-sessions",
      apiToken: "substrate-token",
      providerEnv: { OPENROUTER_API_KEY: "provider-token" },
      defaultTimeoutMs: 120_000,
      defaultIdleTimeoutMs: 30_000,
    });
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("pi");
    expect(calls[0].args).toEqual([
      "-p",
      "--provider",
      "openrouter",
      "--model",
      "moonshotai/kimi-k2.6:floor",
      "--thinking",
      "off",
      "--session-dir",
      "/tmp/pi-sessions",
      "--no-session",
    ]);
    expect(calls[0].opts).toMatchObject({
      cwd: "/tmp",
      stdin: expect.stringContaining("=== TASK ===\ndo work"),
      env: {
        OPENROUTER_API_KEY: "provider-token",
        SUBSTRATE_API_TOKEN: "substrate-token",
      },
      timeoutMs: 120_000,
      idleTimeoutMs: 30_000,
    });
  });

  it("omits provider/model/env when not configured and still uses ephemeral sessions", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts?: unknown }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        return { exitCode: 0, stdout: "ok" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock());
    await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(calls[0].args).toEqual(["-p", "--no-session"]);
    expect(calls[0].opts).toMatchObject({
      timeoutMs: 15 * 60 * 1000,
      idleTimeoutMs: 3 * 60 * 1000,
    });
  });

  it("reports failure on non-zero exit", async () => {
    const runner = makeRunner(1, "", "error");
    const backend = new PiCliBackend(runner, makeClock());
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("reports failure on exception", async () => {
    const runner: IProcessRunner = {
      async run() {
        throw new Error("spawn ENOENT");
      },
    };
    const backend = new PiCliBackend(runner, makeClock());
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("sets name to pi", () => {
    const backend = new PiCliBackend(makeRunner(0, ""), makeClock());
    expect(backend.name).toBe("pi");
  });
});
