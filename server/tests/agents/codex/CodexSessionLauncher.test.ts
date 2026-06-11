import { CodexSessionLauncher } from "../../../src/agents/codex/CodexSessionLauncher";
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

describe("CodexSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let launcher: CodexSessionLauncher;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    launcher = new CodexSessionLauncher(runner, clock);
  });

  it("invokes codex exec with noninteractive MCP-capable flags", async () => {
    runner.enqueue({ stdout: "response", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "Do something" }));

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].args.slice(0, 2)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(calls[0].args).toContain("--json");
    expect(calls[0].args).toContain("--color");
    expect(calls[0].args).toContain("never");
    expect(calls[0].args).toContain("--skip-git-repo-check");
  });

  it("omits model flag when no model is provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest());

    expect(runner.getCalls()[0].args).not.toContain("-m");
  });

  it("omits default Claude model names so Codex can use its configured default", async () => {
    const codexLauncher = new CodexSessionLauncher(runner, clock, "claude-sonnet-4-6");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await codexLauncher.launch(makeRequest(), { model: "claude-opus-4-6" });

    expect(runner.getCalls()[0].args).not.toContain("-m");
  });

  it("uses custom Codex model when provided via options", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { model: "gpt-5.2" });

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gpt-5.2");
  });

  it("passes configured effort as Codex reasoning effort", async () => {
    const codexLauncher = new CodexSessionLauncher(runner, clock, undefined, undefined, "high");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await codexLauncher.launch(makeRequest());

    const args = runner.getCalls()[0].args;
    const configIdx = args.indexOf("-c");
    expect(args[configIdx + 1]).toBe('model_reasoning_effort="high"');
  });

  it("lets launch options override configured effort", async () => {
    const codexLauncher = new CodexSessionLauncher(runner, clock, undefined, undefined, "low");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await codexLauncher.launch(makeRequest(), { effort: "xhigh" });

    const args = runner.getCalls()[0].args;
    const configIdx = args.indexOf("-c");
    expect(args[configIdx + 1]).toBe('model_reasoning_effort="xhigh"');
  });

  it("prepends system prompt to the message when systemPrompt is provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({
      systemPrompt: "You are a helpful assistant.",
      message: "What is 2+2?",
    }));

    const call = runner.getCalls()[0];
    const prompt = call.options?.stdin;
    expect(call.args.at(-1)).toBe("-");
    expect(prompt).toContain("SYSTEM INSTRUCTIONS:");
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt).toContain("What is 2+2?");
  });

  it("does not prepend system section when systemPrompt is empty", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    const call = runner.getCalls()[0];
    expect(call.args.at(-1)).toBe("-");
    expect(call.options?.stdin).toBe("Hello");
  });

  it("passes cwd as -C and as process cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/my/workspace" });

    const call = runner.getCalls()[0];
    expect(call.args).toContain("-C");
    expect(call.args[call.args.indexOf("-C") + 1]).toBe("/my/workspace");
    expect(call.options?.cwd).toBe("/my/workspace");
  });

  it("passes each additionalDir as --add-dir", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { additionalDirs: ["/source/root", "/extra/dir"] });

    const args = runner.getCalls()[0].args;
    const addDirIndices = args.reduce<number[]>((acc, arg, i) => (arg === "--add-dir" ? [...acc, i] : acc), []);
    const addDirValues = addDirIndices.map((i) => args[i + 1]);
    expect(addDirValues).toEqual(["/source/root", "/extra/dir"]);
  });

  it("starts a new codex exec session on the first continueSession call for a cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/workspace/ego", continueSession: true });

    expect(runner.getCalls()[0].args.slice(0, 2)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("keeps continueSession stateless because prompts already include substrate context", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "first" }), { cwd: "/workspace/ego", continueSession: true });
    await launcher.launch(makeRequest({ message: "second" }), { cwd: "/workspace/ego", continueSession: true });

    expect(runner.getCalls()[1].args.slice(0, 2)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(runner.getCalls()[1].args).not.toContain("resume");
    expect(runner.getCalls()[1].args.at(-1)).toBe("-");
    expect(runner.getCalls()[1].options?.stdin).toBe("second");
  });

  it("keeps resume state isolated by cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest(), { cwd: "/workspace/ego", continueSession: true });
    await launcher.launch(makeRequest(), { cwd: "/workspace/id", continueSession: true });

    expect(runner.getCalls()[1].args.slice(0, 2)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("returns success=true and rawOutput on exit code 0", async () => {
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "final output" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10, reasoning_output_tokens: 2 } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("final output");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("parses Codex JSONL usage and estimates known-model cost", async () => {
    const codexLauncher = new CodexSessionLauncher(runner, clock, "gpt-5.5");
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 14646, cached_input_tokens: 7552, output_tokens: 5, reasoning_output_tokens: 0 } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await codexLauncher.launch(makeRequest());

    expect(result.rawOutput).toBe("ok");
    expect(result.usage).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      promptTokens: 14646,
      cachedInputTokens: 7552,
      nonCachedInputTokens: 7094,
      completionTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 14651,
      costUsd: ((7094 * 5) + (7552 * 0.5) + (5 * 30)) / 1_000_000,
      costKnown: false,
      costEstimate: true,
      billingSource: "static_estimate",
      telemetrySource: "codex-exec-json",
    });
  });

  it("emits only agent message text to process logs when reading JSONL stdout", async () => {
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "streamed text" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(entries).toEqual([{ type: "text", content: "streamed text" }]);
  });

  it("returns success=false on non-zero exit code", async () => {
    runner.enqueue({ stdout: "", stderr: "something went wrong", exitCode: 1 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("something went wrong");
  });

  it("returns success=false with error message when process runner throws", async () => {
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });
});
