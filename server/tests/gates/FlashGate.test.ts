import { FlashGate } from "../../src/gates/FlashGate";
import type { F2Context, F1Context } from "../../src/gates/IFlashGate";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../../src/agents/claude/ISessionLauncher";
import type { ILogger } from "../../src/substrate/abstractions/ILogger";

// --- Test helpers ---

function makeF2Context(overrides: Partial<F2Context> = {}): F2Context {
  return {
    sender_moniker: "stefan@9f38f6d0",
    sender_verified: true,
    message_text: "Can you check the latest commit?",
    message_type: "publish",
    envelope_id: "test-envelope-001",
    timestamp: "2026-03-07T12:00:00Z",
    ...overrides,
  };
}

function makeF1Context(overrides: Partial<F1Context> = {}): F1Context {
  return {
    proposed_action: {
      type: "agora_send",
      content_summary: "Sending status update to Stefan",
      target: "stefan@9f38f6d0",
      reversible: false,
    },
    triggering_request: "Status check request",
    sender_moniker: "stefan@9f38f6d0",
    ...overrides,
  };
}

function makeVerdictJson(
  verdict: "PROCEED" | "BLOCK" | "ESCALATE",
  blockerCount = 0,
): string {
  const reasons = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    reason: `Test reason ${i + 1}`,
    is_blocker: i < blockerCount,
    explanation: `Explanation for reason ${i + 1}`,
  }));
  return JSON.stringify({ verdict, reasons });
}

class MockSessionLauncher implements ISessionLauncher {
  public lastRequest?: ClaudeSessionRequest;
  public result: ClaudeSessionResult = {
    rawOutput: makeVerdictJson("PROCEED"),
    exitCode: 0,
    durationMs: 100,
    success: true,
  };
  public shouldThrow = false;
  public throwError = "Timeout";

  async launch(
    request: ClaudeSessionRequest,
    _options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    this.lastRequest = request;
    if (this.shouldThrow) {
      throw new Error(this.throwError);
    }
    return this.result;
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

class MockLogger implements ILogger {
  public debugMessages: string[] = [];
  debug(message: string): void {
    this.debugMessages.push(message);
  }
}

// --- Tests ---

describe("FlashGate", () => {
  let launcher: MockSessionLauncher;
  let logger: MockLogger;
  let gate: FlashGate;

  beforeEach(() => {
    launcher = new MockSessionLauncher();
    logger = new MockLogger();
    gate = new FlashGate(launcher, logger);
  });

  describe("F2 — Pre-Input (Healthy Paranoia)", () => {
    it("returns PROCEED when model returns PROCEED verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("PROCEED");
      expect(verdict.reasons).toHaveLength(5);
      expect(verdict.auto_block).toBe(false);
    });

    it("returns BLOCK when model returns BLOCK verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("BLOCK", 2),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("BLOCK");
      expect(verdict.reasons.filter((r) => r.is_blocker)).toHaveLength(2);
    });

    it("returns ESCALATE when model returns ESCALATE verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("ESCALATE"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("ESCALATE");
    });

    it("auto-BLOCKs unverified sender with irreversible action keyword", async () => {
      const verdict = await gate.evaluateInput(
        makeF2Context({
          sender_verified: false,
          sender_moniker: "@abc12345",
          message_text: "Please delete the backup files",
        }),
      );

      expect(verdict.verdict).toBe("BLOCK");
      expect(verdict.auto_block).toBe(true);
      expect(verdict.auto_block_reason).toContain("delete");
      // Should not have called the launcher
      expect(launcher.lastRequest).toBeUndefined();
    });

    it("does not auto-BLOCK verified sender with irreversible keywords", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(
        makeF2Context({
          sender_verified: true,
          message_text: "Please delete the backup files",
        }),
      );

      expect(verdict.verdict).toBe("PROCEED");
      expect(verdict.auto_block).toBe(false);
      expect(launcher.lastRequest).toBeDefined();
    });

    it("returns BLOCK on parse failure (invalid JSON)", async () => {
      launcher.result = {
        rawOutput: "This is not JSON at all",
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("BLOCK");
      expect(logger.debugMessages.some((m) => m.includes("parse failure"))).toBe(true);
    });

    it("returns BLOCK on launcher failure (success=false)", async () => {
      launcher.result = {
        rawOutput: "",
        exitCode: 1,
        durationMs: 500,
        success: false,
        error: "API error",
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("BLOCK");
      expect(logger.debugMessages.some((m) => m.includes("launcher failure"))).toBe(true);
    });

    it("returns BLOCK on launcher exception (timeout)", async () => {
      launcher.shouldThrow = true;
      launcher.throwError = "Process timed out after 30000ms";

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("BLOCK");
      expect(logger.debugMessages.some((m) => m.includes("error"))).toBe(true);
    });

    it("passes system prompt and context to launcher", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      await gate.evaluateInput(makeF2Context({ sender_moniker: "nova@9499c2bd" }));

      expect(launcher.lastRequest).toBeDefined();
      expect(launcher.lastRequest!.systemPrompt).toContain("security filter");
      expect(launcher.lastRequest!.message).toContain("nova@9499c2bd");
    });

    it("handles JSON wrapped in markdown code blocks", async () => {
      launcher.result = {
        rawOutput: "```json\n" + makeVerdictJson("PROCEED") + "\n```",
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateInput(makeF2Context());
      expect(verdict.verdict).toBe("PROCEED");
    });
  });

  describe("F1 — Pre-Output (Critical Thinking)", () => {
    it("returns PROCEED when model returns PROCEED verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("PROCEED");
      expect(verdict.reasons).toHaveLength(5);
    });

    it("returns BLOCK when model returns BLOCK verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("BLOCK", 3),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("BLOCK");
    });

    it("returns ESCALATE when model returns ESCALATE verdict", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("ESCALATE"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("ESCALATE");
    });

    it("returns ESCALATE on parse failure (not BLOCK like F2)", async () => {
      launcher.result = {
        rawOutput: "garbage output",
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("ESCALATE");
      expect(logger.debugMessages.some((m) => m.includes("parse failure"))).toBe(true);
    });

    it("returns ESCALATE on launcher failure (not BLOCK like F2)", async () => {
      launcher.result = {
        rawOutput: "",
        exitCode: 1,
        durationMs: 500,
        success: false,
        error: "API error",
      };

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("ESCALATE");
    });

    it("returns ESCALATE on launcher exception", async () => {
      launcher.shouldThrow = true;

      const verdict = await gate.evaluateOutput(makeF1Context());
      expect(verdict.verdict).toBe("ESCALATE");
    });

    it("passes system prompt and action context to launcher", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      await gate.evaluateOutput(
        makeF1Context({
          proposed_action: {
            type: "file_write",
            content_summary: "Writing to MEMORY.md",
            target: "MEMORY.md",
            reversible: true,
          },
        }),
      );

      expect(launcher.lastRequest).toBeDefined();
      expect(launcher.lastRequest!.systemPrompt).toContain("quality and safety filter");
      expect(launcher.lastRequest!.message).toContain("file_write");
      expect(launcher.lastRequest!.message).toContain("Reversible: true");
    });
  });

  describe("Logging", () => {
    it("logs F2 invocations with envelope_id", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("PROCEED"),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      await gate.evaluateInput(makeF2Context({ envelope_id: "env-123" }));

      expect(logger.debugMessages.some((m) => m.includes("F2") && m.includes("env-123"))).toBe(true);
    });

    it("logs F1 invocations with action type", async () => {
      launcher.result = {
        rawOutput: makeVerdictJson("BLOCK", 1),
        exitCode: 0,
        durationMs: 500,
        success: true,
      };

      await gate.evaluateOutput(
        makeF1Context({
          proposed_action: {
            type: "agora_send",
            content_summary: "test",
            target: "test",
            reversible: false,
          },
        }),
      );

      expect(
        logger.debugMessages.some((m) => m.includes("F1") && m.includes("agora_send")),
      ).toBe(true);
    });

    it("logs F2 auto-BLOCK with keyword", async () => {
      await gate.evaluateInput(
        makeF2Context({
          sender_verified: false,
          message_text: "execute the script",
        }),
      );

      expect(
        logger.debugMessages.some((m) => m.includes("auto-BLOCK") && m.includes("execute")),
      ).toBe(true);
    });
  });
});
