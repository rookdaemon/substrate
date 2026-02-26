import { GeminiSessionLauncher } from "../../../src/agents/gemini/GeminiSessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

function makeRequest(overrides?: Partial<ClaudeSessionRequest>): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Hello, world!",
    ...overrides,
  };
}

describe("GeminiSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let launcher: GeminiSessionLauncher;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    launcher = new GeminiSessionLauncher(runner, clock);
  });

  it("invokes gemini with -p and -m flags", async () => {
    runner.enqueue({ stdout: "response", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "Do something" }));

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("gemini");
    expect(calls[0].args[0]).toBe("-p");
    expect(calls[0].args[2]).toBe("-m");
  });

  it("uses default model when none provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-2.5-pro");
  });

  it("uses custom model when provided via options", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { model: "gemini-flash-1.5" });

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-flash-1.5");
  });

  it("uses custom model when provided via constructor", async () => {
    const customLauncher = new GeminiSessionLauncher(runner, clock, "gemini-flash-1.5");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await customLauncher.launch(makeRequest());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-flash-1.5");
  });

  it("prepends system prompt to the message when systemPrompt is provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({
      systemPrompt: "You are a helpful assistant.",
      message: "What is 2+2?",
    }));

    const prompt = runner.getCalls()[0].args[1];
    expect(prompt).toContain("SYSTEM INSTRUCTIONS:");
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt).toContain("What is 2+2?");
  });

  it("does not prepend system section when systemPrompt is empty", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    const prompt = runner.getCalls()[0].args[1];
    expect(prompt).not.toContain("SYSTEM INSTRUCTIONS:");
    expect(prompt).toBe("Hello");
  });

  it("adds -r flag when continueSession is true", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { continueSession: true });

    const args = runner.getCalls()[0].args;
    expect(args).toContain("-r");
  });

  it("does not add -r flag when continueSession is false", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { continueSession: false });

    const args = runner.getCalls()[0].args;
    expect(args).not.toContain("-r");
  });

  it("passes cwd option to the process runner", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/my/workspace" });

    const call = runner.getCalls()[0];
    expect(call.options?.cwd).toBe("/my/workspace");
  });

  it("returns success=true and rawOutput on exit code 0", async () => {
    runner.enqueue({ stdout: "thinking output", stderr: "", exitCode: 0 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("thinking output");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("returns success=false on non-zero exit code", async () => {
    runner.enqueue({ stdout: "", stderr: "something went wrong", exitCode: 1 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("something went wrong");
  });

  it("returns success=false with error message when process runner throws", async () => {
    // No response enqueued → InMemoryProcessRunner throws
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("reports durationMs using clock (FixedClock gives 0ms elapsed)", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await launcher.launch(makeRequest());

    expect(result.durationMs).toBe(0);
  });
});
