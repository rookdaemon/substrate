import { AgentSdkLauncher, SdkQueryFn, SdkMessage } from "../../../src/agents/claude/AgentSdkLauncher";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { ProcessLogEntry } from "../../../src/agents/claude/ISessionLauncher";
import { SdkUserMessage } from "../../../src/session/ISdkSession";
import { InMemoryLogger } from "../../../src/logging";

function createMockQueryFn(messages: SdkMessage[]): SdkQueryFn & { getCalls(): Array<{ prompt: string; options?: Record<string, unknown> }> } {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const fn = ((params: { prompt: string; options?: Record<string, unknown> }) => {
    calls.push(params);
    return (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();
  }) as SdkQueryFn & { getCalls(): typeof calls };
  fn.getCalls = () => calls;
  return fn;
}

describe("AgentSdkLauncher", () => {
  const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));

  it("returns success result with rawOutput from result message", async () => {
    const messages: SdkMessage[] = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-5-20250929", claude_code_version: "1.0.0" },
      { type: "result", subtype: "success", result: '{"answer":"42"}', total_cost_usd: 0.01, duration_ms: 1000 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const result = await launcher.launch({ systemPrompt: "You are helpful", message: "What is the answer?" });

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe('{"answer":"42"}');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits ProcessLogEntry for assistant text blocks", async () => {
    const messages: SdkMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      },
      { type: "result", subtype: "success", result: "Hello world", total_cost_usd: 0.01, duration_ms: 500 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    await launcher.launch(
      { systemPrompt: "Be helpful", message: "Hi" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(entries).toContainEqual({ type: "text", content: "Hello world" });
  });

  it("emits ProcessLogEntry for thinking blocks", async () => {
    const messages: SdkMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
      },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.0, duration_ms: 100 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    await launcher.launch(
      { systemPrompt: "Think first", message: "Go" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(entries).toContainEqual({ type: "thinking", content: "Let me think..." });
  });

  it("emits ProcessLogEntry for tool_use blocks", async () => {
    const messages: SdkMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file: "foo.ts" } }] },
      },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.0, duration_ms: 100 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    await launcher.launch(
      { systemPrompt: "Use tools", message: "Go" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(entries).toContainEqual({ type: "tool_use", content: 'Read: {"file":"foo.ts"}' });
  });

  it("emits init status for system messages", async () => {
    const messages: SdkMessage[] = [
      { type: "system", subtype: "init", model: "claude-opus-4-20250514", claude_code_version: "2.0.0" },
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.0, duration_ms: 100 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    await launcher.launch(
      { systemPrompt: "Go", message: "Hi" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(entries).toContainEqual({ type: "status", content: "init: model=claude-opus-4-20250514 v2.0.0" });
  });

  it("emits result status with cost and duration", async () => {
    const messages: SdkMessage[] = [
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.0123, duration_ms: 4567 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    await launcher.launch(
      { systemPrompt: "Go", message: "Hi" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(entries).toContainEqual({ type: "status", content: "result: success, $0.0123, 4567ms" });
  });

  it("returns failure for error result", async () => {
    const messages: SdkMessage[] = [
      { type: "result", subtype: "error_during_execution", errors: ["Something broke"], total_cost_usd: 0.0, duration_ms: 100 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const result = await launcher.launch({ systemPrompt: "Go", message: "Hi" });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Something broke");
  });

  it("returns failure when query throws", async () => {
    const queryFn: SdkQueryFn = () => {
      return (async function* () {
        throw new Error("Connection failed");
      })();
    };
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const result = await launcher.launch({ systemPrompt: "Go", message: "Hi" });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Connection failed");
  });

  it("passes systemPrompt, cwd, and model to query function", async () => {
    const messages: SdkMessage[] = [
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.0, duration_ms: 0 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock, "claude-opus-4-20250514");

    await launcher.launch(
      { systemPrompt: "Be an expert", message: "Help me" },
      { cwd: "/workspace" },
    );

    const calls = queryFn.getCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toBe("Help me");
    expect(calls[0].options?.systemPrompt).toBe("Be an expert");
    expect(calls[0].options?.cwd).toBe("/workspace");
    expect(calls[0].options?.model).toBe("claude-opus-4-20250514");
  });

  it("sets bypassPermissions and persistSession=false", async () => {
    const messages: SdkMessage[] = [
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.0, duration_ms: 0 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    await launcher.launch({ systemPrompt: "Go", message: "Hi" });

    const calls = queryFn.getCalls();
    expect(calls[0].options?.permissionMode).toBe("bypassPermissions");
    expect(calls[0].options?.allowDangerouslySkipPermissions).toBe(true);
    expect(calls[0].options?.persistSession).toBe(false);
  });

  it("uses accumulated text as fallback rawOutput", async () => {
    const messages: SdkMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "First. " }, { type: "text", text: "Second." }] },
      },
      { type: "result", subtype: "success", result: "", total_cost_usd: 0.0, duration_ms: 0 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const result = await launcher.launch({ systemPrompt: "Go", message: "Hi" });

    expect(result.rawOutput).toBe("First. Second.");
  });

  it("handles multiple assistant messages across turns", async () => {
    const messages: SdkMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Step 1. " }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Step 2." }] },
      },
      { type: "result", subtype: "success", result: '{"done":true}', total_cost_usd: 0.05, duration_ms: 3000 },
    ];
    const queryFn = createMockQueryFn(messages);
    const launcher = new AgentSdkLauncher(queryFn, clock);

    const entries: ProcessLogEntry[] = [];
    const result = await launcher.launch(
      { systemPrompt: "Go", message: "Do it" },
      { onLogEntry: (e) => entries.push(e) },
    );

    expect(result.rawOutput).toBe('{"done":true}');
    expect(entries.filter((e) => e.type === "text").length).toBe(2);
    expect(entries.filter((e) => e.type === "tool_use").length).toBe(1);
  });

  describe("inject()", () => {
    function createStreamInputQueryFn(messages: SdkMessage[]): {
      queryFn: SdkQueryFn;
      streamInputCallCount: number;
      getStreamInputMessages: () => SdkUserMessage[];
    } {
      const state = { callCount: 0, messages: [] as SdkUserMessage[] };

      const queryFn: SdkQueryFn = (_params) => {
        const stream = (async function* () {
          // Yield messages with a microtask gap so inject() has a chance to fire
          for (const msg of messages) {
            await new Promise((r) => setTimeout(r, 5));
            yield msg;
          }
        })();

        return Object.assign(stream, {
          streamInput: async (input: AsyncIterable<SdkUserMessage>) => {
            state.callCount++;
            for await (const msg of input) {
              state.messages.push(msg);
            }
          },
          close: () => {},
        });
      };

      return {
        queryFn,
        get streamInputCallCount() { return state.callCount; },
        getStreamInputMessages: () => [...state.messages],
      };
    }

    it("forwards injected message to active session streamInput", async () => {
      const messages: SdkMessage[] = [
        { type: "assistant", message: { content: [{ type: "text", text: "working..." }] } },
        { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, duration_ms: 100 },
      ];
      const { queryFn, getStreamInputMessages } = createStreamInputQueryFn(messages);
      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      const launchPromise = launcher.launch(
        { systemPrompt: "Go", message: "Start" },
      );

      // Give launch() time to create the session and start iterating
      await new Promise((r) => setTimeout(r, 2));

      launcher.inject("hello from user");

      const result = await launchPromise;
      expect(result.success).toBe(true);

      // The message was forwarded via the channel to streamInput
      expect(logger.getEntries().some((e) => e.includes("inject"))).toBe(true);
      expect(getStreamInputMessages().some((m) => m.message.content === "hello from user")).toBe(true);
    });

    it("logs warning when inject called with no active session", () => {
      const messages: SdkMessage[] = [
        { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 0 },
      ];
      const queryFn = createMockQueryFn(messages);
      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      // No launch() called — no active session
      launcher.inject("orphan message");

      expect(logger.getEntries().some((e) => e.includes("no active session"))).toBe(true);
    });

    it("calls streamInput on the SDK stream if available", async () => {
      const messages: SdkMessage[] = [
        { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 0 },
      ];
      const mock = createStreamInputQueryFn(messages);
      const launcher = new AgentSdkLauncher(mock.queryFn, clock);

      await launcher.launch({ systemPrompt: "Go", message: "Start" });

      // streamInput was called when the session was created
      expect(mock.streamInputCallCount).toBe(1);
    });

    it("cleans up message channel after launch completes", async () => {
      const messages: SdkMessage[] = [
        { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 0 },
      ];
      const mock = createStreamInputQueryFn(messages);
      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(mock.queryFn, clock, undefined, logger);

      await launcher.launch({ systemPrompt: "Go", message: "Start" });

      // After launch completes, inject should warn about no active session
      launcher.inject("too late");
      expect(logger.getEntries().some((e) => e.includes("no active session"))).toBe(true);
    });
  });

  describe("retry logic", () => {
    it("retries on failure with exponential backoff", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const attempts: number[] = [];
      let callCount = 0;

      const queryFn: SdkQueryFn = () => {
        callCount++;
        attempts.push(Date.now());
        return (async function* () {
          if (callCount < 3) {
            yield { type: "result", subtype: "error", errors: ["Temporary failure"], total_cost_usd: 0, duration_ms: 100 };
          } else {
            yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 100 };
          }
        })();
      };

      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      const result = await launcher.launch(
        { systemPrompt: "Go", message: "Start" },
        { maxRetries: 3, retryDelayMs: 1000 }
      );

      expect(result.success).toBe(true);
      expect(callCount).toBe(3);
      expect(logger.getEntries().some((e) => e.includes("retry 1/3"))).toBe(true);
      expect(logger.getEntries().some((e) => e.includes("retry 2/3"))).toBe(true);
      expect(logger.getEntries().some((e) => e.includes("succeeded on retry 2"))).toBe(true);
    });

    it("returns failure after exhausting retries", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const queryFn: SdkQueryFn = () => {
        return (async function* () {
          yield { type: "result", subtype: "error", errors: ["Persistent failure"], total_cost_usd: 0, duration_ms: 100 };
        })();
      };

      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      const result = await launcher.launch(
        { systemPrompt: "Go", message: "Start" },
        { maxRetries: 2, retryDelayMs: 500 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Persistent failure");
      expect(logger.getEntries().some((e) => e.includes("all 3 attempts exhausted"))).toBe(true);
    });

    it("succeeds on first attempt when no retries needed", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const messages: SdkMessage[] = [
        { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 100 },
      ];
      const queryFn = createMockQueryFn(messages);
      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      const result = await launcher.launch(
        { systemPrompt: "Go", message: "Start" },
        { maxRetries: 3, retryDelayMs: 1000 }
      );

      expect(result.success).toBe(true);
      expect(queryFn.getCalls().length).toBe(1);
      expect(logger.getEntries().some((e) => e.includes("retry"))).toBe(false);
    });

    it("defaults to no retries when maxRetries not specified", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      let callCount = 0;
      const queryFn: SdkQueryFn = () => {
        callCount++;
        return (async function* () {
          yield { type: "result", subtype: "error", errors: ["Failure"], total_cost_usd: 0, duration_ms: 100 };
        })();
      };

      const launcher = new AgentSdkLauncher(queryFn, clock);

      const result = await launcher.launch({ systemPrompt: "Go", message: "Start" });

      expect(result.success).toBe(false);
      expect(callCount).toBe(1); // No retries
    });

    it("uses exponential backoff for retries", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const queryFn: SdkQueryFn = () => {
        return (async function* () {
          yield { type: "result", subtype: "error", errors: ["Failure"], total_cost_usd: 0, duration_ms: 100 };
        })();
      };

      const logger = new InMemoryLogger();
      const launcher = new AgentSdkLauncher(queryFn, clock, undefined, logger);

      await launcher.launch(
        { systemPrompt: "Go", message: "Start" },
        { maxRetries: 3, retryDelayMs: 100 }
      );

      const entries = logger.getEntries();
      // Retry 1: 100ms, Retry 2: 200ms, Retry 3: 400ms
      expect(entries.some((e) => e.includes("retry 1/3 after 100ms"))).toBe(true);
      expect(entries.some((e) => e.includes("retry 2/3 after 200ms"))).toBe(true);
      expect(entries.some((e) => e.includes("retry 3/3 after 400ms"))).toBe(true);
    });
  });
});
