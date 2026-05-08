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

  it("routes to pi with -p and model flag", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts?: unknown }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        return { exitCode: 0, stdout: "ok" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock(), "moonshotai/kimi-k2.6:floor");
    const result = await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("pi");
    expect(calls[0].args).toEqual(["-p", "--model", "moonshotai/kimi-k2.6:floor"]);
  });

  it("omits model flag when no model configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: IProcessRunner = {
      async run(cmd, args) {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "ok" };
      },
    };
    const backend = new PiCliBackend(runner, makeClock());
    await backend.invoke("do work", {
      codingContext: "",
      fileContents: new Map(),
      cwd: "/tmp",
    });

    expect(calls[0].args).toEqual(["-p"]);
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
