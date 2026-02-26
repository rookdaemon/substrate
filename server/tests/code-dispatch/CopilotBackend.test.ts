import { CopilotBackend } from "../../src/code-dispatch/CopilotBackend";
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

describe("CopilotBackend", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let backend: CopilotBackend;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    backend = new CopilotBackend(runner, clock);
  });

  it("has name 'copilot'", () => {
    expect(backend.name).toBe("copilot");
  });

  it("invokes copilot binary (not claude)", async () => {
    runner.enqueue({ stdout: "done", stderr: "", exitCode: 0 });
    await backend.invoke("Fix the bug", makeContext());

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("copilot");
  });

  it("passes -p, --allow-all-tools, --add-dir, cwd args in that order", async () => {
    runner.enqueue({ stdout: "done", stderr: "", exitCode: 0 });
    const context = makeContext({ cwd: "/tmp/test-repo" });
    await backend.invoke("Fix the bug", context);

    const args = runner.getCalls()[0].args;
    expect(args[0]).toBe("-p");
    // args[1] is the prompt
    expect(args[2]).toBe("--allow-all-tools");
    expect(args[3]).toBe("--add-dir");
    expect(args[4]).toBe("/tmp/test-repo");
  });

  it("includes --model when provided in constructor", async () => {
    const customBackend = new CopilotBackend(runner, clock, "gpt-4o");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await customBackend.invoke("task", makeContext());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("gpt-4o");
  });

  it("does not include --model when not provided in constructor", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await backend.invoke("task", makeContext());

    const args = runner.getCalls()[0].args;
    expect(args).not.toContain("--model");
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

  it("returns success=false and empty output when processRunner throws", async () => {
    // No responses enqueued → InMemoryProcessRunner throws
    const result = await backend.invoke("task", makeContext());
    expect(result.success).toBe(false);
    expect(result.output).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("passes cwd from SubstrateSlice to process runner options", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });
    await backend.invoke("spec", makeContext({ cwd: "/my/project" }));

    const call = runner.getCalls()[0];
    expect(call.options?.cwd).toBe("/my/project");
  });

  it("prompt includes coding context, file contents, and spec sections", async () => {
    runner.enqueue({ stdout: "done", stderr: "", exitCode: 0 });
    const context = makeContext({
      codingContext: "# Coding Context\nUse TypeScript.",
      fileContents: new Map([["src/foo.ts", "export {}"]]),
    });
    await backend.invoke("Fix the bug", context);

    const prompt = runner.getCalls()[0].args[1];
    expect(prompt).toContain("CODING CONTEXT");
    expect(prompt).toContain("Coding Context");
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("export {}");
    expect(prompt).toContain("Fix the bug");
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

  it("reports durationMs using clock (FixedClock gives 0ms elapsed)", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await backend.invoke("task", makeContext());
    // FixedClock always returns the same timestamp so elapsed = 0
    expect(result.durationMs).toBe(0);
  });
});
