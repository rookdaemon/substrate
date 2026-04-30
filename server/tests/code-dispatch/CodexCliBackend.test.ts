import { CodexCliBackend } from "../../src/code-dispatch/CodexCliBackend";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("CodexCliBackend", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let backend: CodexCliBackend;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    backend = new CodexCliBackend(runner, clock);
  });

  it("has name 'codex'", () => {
    expect(backend.name).toBe("codex");
  });

  it("invokes codex exec with headless automatic flags", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });

    await backend.invoke("Fix bug", { codingContext: "", fileContents: new Map(), cwd: "/repo" });

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].args.slice(0, 2)).toEqual(["exec", "--full-auto"]);
    expect(calls[0].args).toContain("--skip-git-repo-check");
    expect(calls[0].args).toContain("-C");
    expect(calls[0].args[calls[0].args.indexOf("-C") + 1]).toBe("/repo");
    expect(calls[0].options?.cwd).toBe("/repo");
  });

  it("passes a non-Claude model when configured", async () => {
    const customBackend = new CodexCliBackend(runner, clock, "gpt-5.2");
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });

    await customBackend.invoke("Task", { codingContext: "", fileContents: new Map(), cwd: "/repo" });

    const args = runner.getCalls()[0].args;
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.2");
  });

  it("omits default Claude model names", async () => {
    const customBackend = new CodexCliBackend(runner, clock, "claude-sonnet-4-6");
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });

    await customBackend.invoke("Task", { codingContext: "", fileContents: new Map(), cwd: "/repo" });

    expect(runner.getCalls()[0].args).not.toContain("-m");
  });

  it("returns failure result when codex exits non-zero", async () => {
    runner.enqueue({ stdout: "bad", stderr: "err", exitCode: 2 });

    const result = await backend.invoke("Task", { codingContext: "", fileContents: new Map(), cwd: "/repo" });

    expect(result.success).toBe(false);
    expect(result.output).toBe("bad");
    expect(result.exitCode).toBe(2);
  });
});
