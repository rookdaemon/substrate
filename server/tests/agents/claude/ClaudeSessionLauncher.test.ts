import { ClaudeSessionLauncher } from "../../../src/agents/claude/ClaudeSessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../../src/logging";
import { ProcessLogEntry } from "../../../src/agents/claude/StreamJsonParser";
import { asStreamJson } from "../../helpers/streamJson";

function makeAssistantLine(content: Array<Record<string, unknown>>): string {
  return JSON.stringify({ type: "assistant", message: { content } });
}

function makeResultLine(result: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result, total_cost_usd: 0, duration_ms: 0 });
}

describe("ClaudeSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let launcher: ClaudeSessionLauncher;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    launcher = new ClaudeSessionLauncher(runner, clock);
  });

  it("sends system prompt and message via claude CLI", async () => {
    runner.enqueue({ stdout: asStreamJson('{"action":"idle"}'), stderr: "", exitCode: 0 });

    await launcher.launch({
      systemPrompt: "You are the Ego",
      message: "What should we do?",
    });

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args).toContain("--print");
    expect(calls[0].args).toContain("--verbose");
    expect(calls[0].args).toContain("--dangerously-skip-permissions");
    expect(calls[0].args).toContain("--output-format");
    expect(calls[0].args).toContain("stream-json");

    const spIdx = calls[0].args.indexOf("--system-prompt");
    expect(spIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0].args[spIdx + 1]).toBe("You are the Ego");

    const lastArg = calls[0].args[calls[0].args.length - 1];
    expect(lastArg).toBe("What should we do?");
  });

  it("returns success result on exit code 0 with parsed text", async () => {
    runner.enqueue({ stdout: asStreamJson('{"action":"idle"}'), stderr: "", exitCode: 0 });

    const result = await launcher.launch({
      systemPrompt: "sys",
      message: "msg",
    });

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe('{"action":"idle"}');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("returns failure result on non-zero exit code", async () => {
    runner.enqueue({ stdout: "", stderr: "Claude crashed", exitCode: 1 });

    const result = await launcher.launch({
      systemPrompt: "sys",
      message: "msg",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("Claude crashed");
  });

  it("computes durationMs from clock", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });

    clock.setNow(new Date("2025-06-15T10:00:00.000Z"));

    const launchPromise = launcher.launch({
      systemPrompt: "sys",
      message: "msg",
    });

    clock.setNow(new Date("2025-06-15T10:00:05.000Z"));

    const result = await launchPromise;
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("retries on failure up to maxRetries", async () => {
    runner.enqueue({ stdout: "", stderr: "fail1", exitCode: 1 });
    runner.enqueue({ stdout: "", stderr: "fail2", exitCode: 1 });
    runner.enqueue({ stdout: asStreamJson('{"ok":true}'), stderr: "", exitCode: 0 });

    const result = await launcher.launch(
      { systemPrompt: "sys", message: "msg" },
      { maxRetries: 3, retryDelayMs: 0 }
    );

    expect(result.success).toBe(true);
    expect(runner.getCalls()).toHaveLength(3);
  });

  it("returns last failure after exhausting retries", async () => {
    runner.enqueue({ stdout: "", stderr: "fail1", exitCode: 1 });
    runner.enqueue({ stdout: "", stderr: "fail2", exitCode: 1 });

    const result = await launcher.launch(
      { systemPrompt: "sys", message: "msg" },
      { maxRetries: 2, retryDelayMs: 0 }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("fail2");
    expect(runner.getCalls()).toHaveLength(2);
  });

  it("defaults to 1 attempt (no retries) when options not specified", async () => {
    runner.enqueue({ stdout: "", stderr: "fail", exitCode: 1 });

    const result = await launcher.launch({
      systemPrompt: "sys",
      message: "msg",
    });

    expect(result.success).toBe(false);
    expect(runner.getCalls()).toHaveLength(1);
  });

  describe("stream-json parsing", () => {
    it("forwards parsed log entries via onLogEntry callback", async () => {
      const streamOutput =
        makeAssistantLine([
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
        ]) + "\n" +
        makeResultLine("answer") + "\n";
      runner.enqueue({ stdout: streamOutput, stderr: "", exitCode: 0 });

      const logEntries: ProcessLogEntry[] = [];
      await launcher.launch(
        { systemPrompt: "sys", message: "msg" },
        { onLogEntry: (entry) => logEntries.push(entry) }
      );

      expect(logEntries.some((e) => e.type === "thinking" && e.content === "hmm")).toBe(true);
      expect(logEntries.some((e) => e.type === "text" && e.content === "answer")).toBe(true);
      expect(logEntries.some((e) => e.type === "status")).toBe(true); // result line
    });

    it("uses result field for rawOutput", async () => {
      const streamOutput =
        makeAssistantLine([
          { type: "thinking", thinking: "step1" },
          { type: "text", text: "part1 part2" },
        ]) + "\n" +
        makeResultLine("part1 part2") + "\n";
      runner.enqueue({ stdout: streamOutput, stderr: "", exitCode: 0 });

      const result = await launcher.launch({
        systemPrompt: "sys",
        message: "msg",
      });

      expect(result.rawOutput).toBe("part1 part2");
    });

    it("works without onLogEntry callback", async () => {
      runner.enqueue({ stdout: asStreamJson("hello"), stderr: "", exitCode: 0 });

      const result = await launcher.launch({
        systemPrompt: "sys",
        message: "msg",
      });

      expect(result.rawOutput).toBe("hello");
    });

    it("uses onStdout to pipe chunks through parser", async () => {
      runner.enqueue({ stdout: asStreamJson("streamed"), stderr: "", exitCode: 0 });

      await launcher.launch({
        systemPrompt: "sys",
        message: "msg",
      });

      const calls = runner.getCalls();
      expect(calls[0].options?.onStdout).toBeDefined();
    });

    it("passes cwd through to process runner", async () => {
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await launcher.launch(
        { systemPrompt: "sys", message: "msg" },
        { cwd: "/my/substrate" }
      );

      const calls = runner.getCalls();
      expect(calls[0].options?.cwd).toBe("/my/substrate");
    });
  });

  describe("debug logging", () => {
    it("logs the full claude command invocation", async () => {
      const logger = new InMemoryLogger();
      const loggedLauncher = new ClaudeSessionLauncher(runner, clock, "sonnet", logger);
      runner.enqueue({ stdout: asStreamJson('{"action":"idle"}'), stderr: "", exitCode: 0 });

      await loggedLauncher.launch({
        systemPrompt: "You are the Ego",
        message: "What should we do next?",
      });

      const entries = logger.getEntries();
      const cmdLine = entries.find((e) => e.includes("$ claude"));
      expect(cmdLine).toBeDefined();
      expect(cmdLine).toContain("--print");
      expect(cmdLine).toContain("--dangerously-skip-permissions");
      expect(cmdLine).toContain("--model");
      expect(cmdLine).toContain("sonnet");
      expect(cmdLine).toContain("What should we do next?");
    });

    it("logs each process log entry", async () => {
      const logger = new InMemoryLogger();
      const loggedLauncher = new ClaudeSessionLauncher(runner, clock, "sonnet", logger);

      const streamOutput =
        makeAssistantLine([
          { type: "thinking", thinking: "analyzing" },
          { type: "text", text: "the answer" },
        ]) + "\n" +
        makeResultLine("the answer") + "\n";
      runner.enqueue({ stdout: streamOutput, stderr: "", exitCode: 0 });

      await loggedLauncher.launch({ systemPrompt: "sys", message: "msg" });

      const entries = logger.getEntries();
      expect(entries.some((e) => e.includes("[thinking]"))).toBe(true);
      expect(entries.some((e) => e.includes("[text]"))).toBe(true);
    });

    it("logs launch result with exit code and duration", async () => {
      const logger = new InMemoryLogger();
      const loggedLauncher = new ClaudeSessionLauncher(runner, clock, "sonnet", logger);
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await loggedLauncher.launch({ systemPrompt: "sys", message: "msg" });

      const entries = logger.getEntries();
      expect(entries.some((e) => e.includes("launch: done") && e.includes("exitCode=0"))).toBe(true);
    });

    it("logs stderr on failure", async () => {
      const logger = new InMemoryLogger();
      const loggedLauncher = new ClaudeSessionLauncher(runner, clock, "sonnet", logger);
      runner.enqueue({ stdout: "", stderr: "model not found", exitCode: 1 });

      await loggedLauncher.launch({ systemPrompt: "sys", message: "msg" });

      const entries = logger.getEntries();
      expect(entries.some((e) => e.includes("model not found"))).toBe(true);
    });

    it("logs retry attempts", async () => {
      const logger = new InMemoryLogger();
      const loggedLauncher = new ClaudeSessionLauncher(runner, clock, "sonnet", logger);
      runner.enqueue({ stdout: "", stderr: "fail", exitCode: 1 });
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await loggedLauncher.launch(
        { systemPrompt: "sys", message: "msg" },
        { maxRetries: 2, retryDelayMs: 0 }
      );

      const entries = logger.getEntries();
      expect(entries.some((e) => e.includes("attempt 1/2"))).toBe(true);
      expect(entries.some((e) => e.includes("attempt 2/2"))).toBe(true);
    });
  });

  describe("model selection", () => {
    it("defaults to sonnet model", async () => {
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await launcher.launch({ systemPrompt: "sys", message: "msg" });

      const calls = runner.getCalls();
      const modelIdx = calls[0].args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(calls[0].args[modelIdx + 1]).toBe("sonnet");
    });

    it("uses model from constructor when provided", async () => {
      const customLauncher = new ClaudeSessionLauncher(runner, clock, "opus");
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await customLauncher.launch({ systemPrompt: "sys", message: "msg" });

      const calls = runner.getCalls();
      const modelIdx = calls[0].args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(calls[0].args[modelIdx + 1]).toBe("opus");
    });

    it("uses haiku when configured", async () => {
      const haikuLauncher = new ClaudeSessionLauncher(runner, clock, "haiku");
      runner.enqueue({ stdout: asStreamJson("ok"), stderr: "", exitCode: 0 });

      await haikuLauncher.launch({ systemPrompt: "sys", message: "msg" });

      const calls = runner.getCalls();
      const modelIdx = calls[0].args.indexOf("--model");
      expect(calls[0].args[modelIdx + 1]).toBe("haiku");
    });
  });
});
