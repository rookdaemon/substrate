import { PiSessionLauncher } from "../../../src/agents/pi/PiSessionLauncher";
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

describe("PiSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2026-05-07T00:00:00.000Z"));
  });

  it("invokes pi in JSON event stream mode by default", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const launcher = new PiSessionLauncher(runner, clock);

    await launcher.launch(makeRequest({ message: "Do work" }));

    const call = runner.getCalls()[0];
    expect(call.command).toBe("pi");
    expect(call.args.slice(0, 2)).toEqual(["--mode", "json"]);
    expect(call.args).not.toContain("Do work");
    expect(call.options?.stdin).toBe("Do work");
  });

  it("passes provider, model, session directory, cwd, and full prompt to Pi shell", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const launcher = new PiSessionLauncher(runner, clock, {
      provider: "openai",
      model: "gpt-5.5",
      sessionDir: "/substrate/pi-sessions",
      thinking: "off",
      apiToken: "local-token",
      providerEnv: { OPENAI_API_KEY: "provider-token" },
    });

    await launcher.launch(makeRequest({
      systemPrompt: "System rules",
      message: "Task",
    }), {
      cwd: "/workspace/ego",
      continueSession: true,
      persistSession: true,
    });

    const call = runner.getCalls()[0];
    expect(call.options?.cwd).toBe("/workspace/ego");
    expect(call.options?.env).toEqual({
      OPENAI_API_KEY: "provider-token",
      SUBSTRATE_API_TOKEN: "local-token",
    });
    expect(call.args).toContain("--provider");
    expect(call.args[call.args.indexOf("--provider") + 1]).toBe("openai");
    expect(call.args).toContain("--model");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(call.args).toContain("--thinking");
    expect(call.args[call.args.indexOf("--thinking") + 1]).toBe("off");
    expect(call.args).toContain("--session-dir");
    expect(call.args[call.args.indexOf("--session-dir") + 1]).toBe("/substrate/pi-sessions");
    expect(call.args).toContain("--continue");
    expect(call.args).not.toContain("--append-system-prompt");
    expect(call.args).not.toContain("System rules");
    expect(call.args).not.toContain("Task");
    expect(call.options?.stdin).toBe("SYSTEM INSTRUCTIONS:\nSystem rules\n\n---\n\nTask");
  });

  it("applies bounded Pi process defaults and allows per-launch override", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const launcher = new PiSessionLauncher(runner, clock, {
      defaultTimeoutMs: 120_000,
      defaultIdleTimeoutMs: 30_000,
    });

    await launcher.launch(makeRequest());
    await launcher.launch(makeRequest(), { timeoutMs: 10_000, idleTimeoutMs: 2_000 });

    expect(runner.getCalls()[0].options?.timeoutMs).toBe(120_000);
    expect(runner.getCalls()[0].options?.idleTimeoutMs).toBe(30_000);
    expect(runner.getCalls()[1].options?.timeoutMs).toBe(10_000);
    expect(runner.getCalls()[1].options?.idleTimeoutMs).toBe(2_000);
  });

  it("supports print mode and ephemeral sessions", async () => {
    runner.enqueue({ stdout: "plain response", stderr: "", exitCode: 0 });
    const launcher = new PiSessionLauncher(runner, clock, { mode: "print" });

    const result = await launcher.launch(makeRequest({ message: "Task" }), { persistSession: false });

    expect(runner.getCalls()[0].args.slice(0, 1)).toEqual(["-p"]);
    expect(runner.getCalls()[0].args).toContain("--no-session");
    expect(runner.getCalls()[0].args).not.toContain("Task");
    expect(runner.getCalls()[0].options?.stdin).toBe("Task");
    expect(result.rawOutput).toBe("plain response");
  });

  it("extracts the final assistant message from Pi JSONL events", async () => {
    const launcher = new PiSessionLauncher(runner, clock, { model: "gpt-5.5" });
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "draft" }] } }),
        JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }] }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("final");
  });

  it("emits streaming process log entries from JSON events", async () => {
    const launcher = new PiSessionLauncher(runner, clock);
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }),
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } }),
        JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
        JSON.stringify({ type: "tool_execution_end", result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
      ].join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(entries).toEqual([
      { type: "text", content: "hello world" },
      { type: "tool_use", content: JSON.stringify({ tool: "bash", args: { command: "npm test" } }) },
      { type: "tool_result", content: "ok" },
    ]);
  });

  it("maps current Pi message events without logging tool-call narration as text", async () => {
    const launcher = new PiSessionLauncher(runner, clock, { model: "moonshotai/kimi-k2.6:floor" });
    runner.enqueue({
      stdout: [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I will inspect the file. </think> " },
              { type: "toolCall", name: "bash", arguments: { command: "rg TODO" } },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "{\"result\":\"success\",\"summary\":\"done\"}" }],
          },
          usage: { input: 10, output: 2, cost: { total: 0.001 } },
        }),
      ].join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    const result = await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(result.rawOutput).toBe("{\"result\":\"success\",\"summary\":\"done\"}");
    expect(entries).toEqual([
      { type: "tool_use", content: JSON.stringify({ tool: "bash", args: { command: "rg TODO" } }) },
      { type: "tool_result", content: "ok" },
    ]);
  });

  it("emits plain assistant text from current Pi message events", async () => {
    const launcher = new PiSessionLauncher(runner, clock);
    runner.enqueue({
      stdout: [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "plain answer" }],
          },
        }),
      ].join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    const result = await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(result.rawOutput).toBe("plain answer");
    expect(entries).toEqual([{ type: "text", content: "plain answer" }]);
  });

  it("suppresses low-value single-token assistant text without changing raw output", async () => {
    const launcher = new PiSessionLauncher(runner, clock);
    runner.enqueue({
      stdout: [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "analysis" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "material update is ready" }],
          },
        }),
      ].join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    const result = await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(result.rawOutput).toBe("material update is ready");
    expect(entries).toEqual([{ type: "text", content: "material update is ready" }]);
  });

  it("caps long process-log text entries while keeping raw output complete", async () => {
    const launcher = new PiSessionLauncher(runner, clock, { maxLoggedTextChars: 12 });
    const longText = "this assistant message should be clipped in process log";
    runner.enqueue({
      stdout: JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: longText }],
        },
      }) + "\n",
      stderr: "",
      exitCode: 0,
    });
    const entries: Array<{ type: string; content: string }> = [];

    const result = await launcher.launch(makeRequest(), { onLogEntry: (entry) => entries.push(entry) });

    expect(result.rawOutput).toBe(longText);
    expect(entries[0].content).toContain("this assista");
    expect(entries[0].content).toContain("[truncated");
  });

  it("maps usage-like JSON fields when Pi includes them", async () => {
    const launcher = new PiSessionLauncher(runner, clock, { model: "gpt-5.5" });
    runner.enqueue({
      stdout: [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, cacheRead: 40, output: 10, totalTokens: 110, cost: { total: 0.01 } } } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await launcher.launch(makeRequest());

    expect(result.usage).toEqual({
      provider: "pi",
      model: "gpt-5.5",
      promptTokens: 100,
      cachedInputTokens: 40,
      nonCachedInputTokens: 60,
      completionTokens: 10,
      totalTokens: 110,
      costUsd: 0.01,
      costKnown: true,
      costEstimate: false,
      billingSource: "cli_usage",
      telemetrySource: "pi-json-event-stream",
    });
  });

  it("returns failure when the pi process fails", async () => {
    const launcher = new PiSessionLauncher(runner, clock);
    runner.enqueue({ stdout: "", stderr: "auth failed", exitCode: 1 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain("auth failed");
  });
});
