import { CopilotSessionLauncher } from "../../../src/agents/copilot/CopilotSessionLauncher";
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

const FIXED_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("CopilotSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let launcher: CopilotSessionLauncher;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    launcher = new CopilotSessionLauncher(runner, clock, undefined, () => FIXED_UUID);
  });

  it("invokes copilot with -p, --allow-all-tools, --silent, and --model flags", async () => {
    runner.enqueue({ stdout: "response", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "Do something" }));

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("copilot");
    expect(calls[0].args[0]).toBe("-p");
    expect(calls[0].args).toContain("--allow-all-tools");
    expect(calls[0].args).toContain("--silent");
    expect(calls[0].args).toContain("--model");
  });

  it("uses default model when none provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4.5");
  });

  it("uses custom model when provided via options", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { model: "claude-opus-4" });

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-opus-4");
  });

  it("uses custom model when provided via constructor", async () => {
    const customLauncher = new CopilotSessionLauncher(runner, clock, "claude-opus-4", () => FIXED_UUID);
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await customLauncher.launch(makeRequest());

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-opus-4");
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

  it("passes cwd as --add-dir when provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/my/workspace" });

    const args = runner.getCalls()[0].args;
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/my/workspace");
  });

  it("passes cwd option to the process runner", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/my/workspace" });

    const call = runner.getCalls()[0];
    expect(call.options?.cwd).toBe("/my/workspace");
  });

  describe("session continuity", () => {
    it("passes --resume with generated UUID on first call with continueSession=true", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      await launcher.launch(makeRequest(), { continueSession: true, cwd: "/workspace/ego" });

      const args = runner.getCalls()[0].args;
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe(FIXED_UUID);
    });

    it("reuses the same session ID for subsequent calls with the same cwd", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await launcher.launch(makeRequest(), { continueSession: true, cwd: "/workspace/ego" });
      await launcher.launch(makeRequest(), { continueSession: true, cwd: "/workspace/ego" });

      const calls = runner.getCalls();
      const id1 = calls[0].args[calls[0].args.indexOf("--resume") + 1];
      const id2 = calls[1].args[calls[1].args.indexOf("--resume") + 1];
      expect(id1).toBe(id2);
    });

    it("uses different session IDs for different cwd values", async () => {
      let callCount = 0;
      const launcher2 = new CopilotSessionLauncher(runner, clock, undefined, () => `uuid-${++callCount}`);

      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await launcher2.launch(makeRequest(), { continueSession: true, cwd: "/workspace/ego" });
      await launcher2.launch(makeRequest(), { continueSession: true, cwd: "/workspace/superego" });

      const calls = runner.getCalls();
      const id1 = calls[0].args[calls[0].args.indexOf("--resume") + 1];
      const id2 = calls[1].args[calls[1].args.indexOf("--resume") + 1];
      expect(id1).not.toBe(id2);
    });

    it("does not add --resume when continueSession is false", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      await launcher.launch(makeRequest(), { continueSession: false, cwd: "/workspace/ego" });

      expect(runner.getCalls()[0].args).not.toContain("--resume");
    });

    it("does not add --resume when continueSession is absent", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      await launcher.launch(makeRequest(), { cwd: "/workspace/ego" });

      expect(runner.getCalls()[0].args).not.toContain("--resume");
    });

    it("does not add --resume when cwd is absent even if continueSession is true", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
      await launcher.launch(makeRequest(), { continueSession: true });

      expect(runner.getCalls()[0].args).not.toContain("--resume");
    });
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

  describe("MCP server config", () => {
    it("passes --additional-mcp-config with correct JSON when mcpServers provided", async () => {
      const mcpServers = {
        tinybus: { type: "http", url: "http://localhost:3001/mcp" },
      };
      const mcpLauncher = new CopilotSessionLauncher(
        runner, clock, undefined, () => FIXED_UUID, [], mcpServers,
      );
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await mcpLauncher.launch(makeRequest());

      const args = runner.getCalls()[0].args;
      expect(args).toContain("--additional-mcp-config");
      const configIdx = args.indexOf("--additional-mcp-config");
      const configJson = args[configIdx + 1];
      const parsed = JSON.parse(configJson);
      expect(parsed).toEqual({
        mcpServers: {
          tinybus: { type: "http", url: "http://localhost:3001/mcp" },
        },
      });
    });

    it("omits --additional-mcp-config when no mcpServers provided", async () => {
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await launcher.launch(makeRequest());

      const args = runner.getCalls()[0].args;
      expect(args).not.toContain("--additional-mcp-config");
    });

    it("omits --additional-mcp-config when mcpServers is empty", async () => {
      const emptyLauncher = new CopilotSessionLauncher(
        runner, clock, undefined, () => FIXED_UUID, [], {},
      );
      runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await emptyLauncher.launch(makeRequest());

      const args = runner.getCalls()[0].args;
      expect(args).not.toContain("--additional-mcp-config");
    });
  });
});
