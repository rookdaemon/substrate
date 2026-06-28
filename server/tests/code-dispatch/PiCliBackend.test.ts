import { PiCliBackend, inferProviderFromModel } from "../../src/code-dispatch/PiCliBackend";
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
        return { exitCode: 0, stdout: "ok", stderr: "" };
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
        return { exitCode: 0, stdout: "ok", stderr: "" };
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

  it("includes stderr in output on failure so errors like 401 are diagnosable", async () => {
    const runner = makeRunner(1, "", "401 User not found");
    const backend = new PiCliBackend(runner, makeClock());
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(false);
    expect(result.output).toBe("401 User not found");
  });

  it("includes both stdout and stderr in output on failure when both present", async () => {
    const runner = makeRunner(1, "partial output", "auth error");
    const backend = new PiCliBackend(runner, makeClock());
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("partial output");
    expect(result.output).toContain("auth error");
  });

  it("includes exception message in output on spawn failure", async () => {
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
    expect(result.output).toContain("spawn ENOENT");
  });

  it("accepts model string shorthand", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args) {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock(), "moonshotai/kimi-k2.6:floor");
    await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(calls[0].args).toContain("--model");
    expect(calls[0].args[calls[0].args.indexOf("--model") + 1]).toBe("moonshotai/kimi-k2.6:floor");
  });

  it("infers --provider from model string prefix when provider not explicit", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args) {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    // No explicit provider — should infer "openrouter" from model prefix
    const backend = new PiCliBackend(runner, makeClock(), "openrouter/moonshotai/kimi-k2.6:floor");
    await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(calls[0].args).toContain("--provider");
    expect(calls[0].args[calls[0].args.indexOf("--provider") + 1]).toBe("openrouter");
  });

  it("does not add --provider when model has no slash prefix", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args) {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock(), "kimi-k2.6:floor");
    await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(calls[0].args).not.toContain("--provider");
  });

  it("sets name to pi", () => {
    const backend = new PiCliBackend(makeRunner(0, ""), makeClock());
    expect(backend.name).toBe("pi");
  });
});

describe("inferProviderFromModel", () => {
  it("extracts provider prefix from slash-delimited model string", () => {
    expect(inferProviderFromModel("openrouter/moonshotai/kimi")).toBe("openrouter");
  });

  it("returns undefined when model has no slash", () => {
    expect(inferProviderFromModel("kimi-k2.6:floor")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(inferProviderFromModel(undefined)).toBeUndefined();
  });
});
