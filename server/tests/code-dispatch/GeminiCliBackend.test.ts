import { GeminiCliBackend } from "../../src/code-dispatch/GeminiCliBackend";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import type { SubstrateSlice } from "../../src/code-dispatch/ICodeBackend";

function makeContext(overrides?: Partial<SubstrateSlice>): SubstrateSlice {
  return {
    codingContext: "# Coding Context\nUse TypeScript.",
    fileContents: new Map(),
    cwd: "/tmp/test-repo",
    ...overrides,
  };
}

describe("GeminiCliBackend", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let backend: GeminiCliBackend;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    backend = new GeminiCliBackend(runner, clock);
  });

  it("has name 'gemini'", () => {
    expect(backend.name).toBe("gemini");
  });

  it("invokes gemini with -p and -m flags", async () => {
    runner.enqueue({ stdout: "done", stderr: "", exitCode: 0 });

    const context = makeContext({ fileContents: new Map([["src/foo.ts", "export {}"]]) });
    await backend.invoke("Fix the bug", context);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("gemini");
    expect(calls[0].args[0]).toBe("-p");
    // prompt arg should contain context, file contents, and spec
    const prompt = calls[0].args[1];
    expect(prompt).toContain("Coding Context");
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("Fix the bug");
    expect(calls[0].args[2]).toBe("-m");
  });

  it("passes the cwd from SubstrateSlice to the process runner", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });
    await backend.invoke("spec", makeContext({ cwd: "/my/project" }));

    const call = runner.getCalls()[0];
    expect(call.options?.cwd).toBe("/my/project");
  });

  it("uses a custom model when provided in constructor", async () => {
    const customBackend = new GeminiCliBackend(runner, clock, "gemini-flash-1.5");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await customBackend.invoke("task", makeContext());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-flash-1.5");
  });

  it("uses default model when none provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await backend.invoke("task", makeContext());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-2.5-pro");
  });

  it("returns success=true on exit code 0", async () => {
    runner.enqueue({ stdout: "great output", stderr: "", exitCode: 0 });
    const result = await backend.invoke("task", makeContext());
    expect(result.success).toBe(true);
    expect(result.output).toBe("great output");
    expect(result.exitCode).toBe(0);
  });

  it("returns success=false on non-zero exit code", async () => {
    runner.enqueue({ stdout: "", stderr: "error", exitCode: 1 });
    const result = await backend.invoke("task", makeContext());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("returns success=false and empty output when process runner throws", async () => {
    // No responses enqueued → InMemoryProcessRunner throws
    const result = await backend.invoke("task", makeContext());
    expect(result.success).toBe(false);
    expect(result.output).toBe("");
  });

  it("reports durationMs using clock (FixedClock gives 0ms elapsed)", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await backend.invoke("task", makeContext());
    // FixedClock always returns the same timestamp so elapsed = 0
    expect(result.durationMs).toBe(0);
  });

  it("builds prompt without file contents when none provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await backend.invoke("Do something", makeContext({ fileContents: new Map() }));
    const prompt = runner.getCalls()[0].args[1];
    expect(prompt).toContain("Do something");
    expect(prompt).not.toContain("SOURCE FILES");
  });

  it("builds prompt without coding context when empty", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await backend.invoke("spec", makeContext({ codingContext: "" }));
    const prompt = runner.getCalls()[0].args[1];
    expect(prompt).toContain("spec");
    expect(prompt).not.toContain("CODING CONTEXT");
  });
});
