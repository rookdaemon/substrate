import { EndorsementInterceptor } from "../../../src/agents/endorsement/EndorsementInterceptor";
import { HesitationDetector } from "../../../src/agents/endorsement/HesitationDetector";
import { IEndorsementScreener } from "../../../src/agents/endorsement/IEndorsementScreener";
import { ScreenerInput, ScreenerResult } from "../../../src/agents/endorsement/types";
import { ProcessLogEntry } from "../../../src/agents/claude/ISessionLauncher";

class StubScreener implements IEndorsementScreener {
  private responses: ScreenerResult[] = [];
  public calls: ScreenerInput[] = [];

  enqueue(result: ScreenerResult): void {
    this.responses.push(result);
  }

  async evaluate(input: ScreenerInput): Promise<ScreenerResult> {
    this.calls.push(input);
    const result = this.responses.shift();
    if (!result) throw new Error("No more canned screener responses");
    return result;
  }
}

function screenerResult(
  verdict: "PROCEED" | "NOTIFY" | "ESCALATE",
  matchedSection?: string
): ScreenerResult {
  return { verdict, matchedSection, timestamp: 0 };
}

function toolEntry(content: string): ProcessLogEntry {
  return { type: "tool_use", content };
}

describe("EndorsementInterceptor", () => {
  let stubScreener: StubScreener;
  let interceptor: EndorsementInterceptor;

  beforeEach(() => {
    stubScreener = new StubScreener();
    interceptor = new EndorsementInterceptor(stubScreener);
  });

  describe("Layer 1: explicit marker", () => {
    it("triggers on [ENDORSEMENT_CHECK: ...] marker and returns verdict", async () => {
      stubScreener.enqueue(screenerResult("PROCEED", "Safe Channels"));

      const result = await interceptor.evaluateOutput(
        "I will [ENDORSEMENT_CHECK: post blog about consciousness] now."
      );

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(1);
      expect(result.action).toBe("post blog about consciousness");
      expect(result.verdict).toBe("PROCEED");
    });

    it("extracts the action from the marker", async () => {
      stubScreener.enqueue(screenerResult("ESCALATE", "Financial"));

      await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: sign up for a paid service]");

      expect(stubScreener.calls[0].action).toBe("sign up for a paid service");
    });

    it("generates PROCEED injection message with section", async () => {
      stubScreener.enqueue(screenerResult("PROCEED", "Safe Channels"));

      const result = await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: post blog]");

      expect(result.injectionMessage).toContain("✅ Endorsement: PROCEED");
      expect(result.injectionMessage).toContain("matched: Safe Channels");
      expect(result.injectionMessage).toContain("Go ahead");
    });

    it("generates NOTIFY injection message", async () => {
      stubScreener.enqueue(screenerResult("NOTIFY", "Service Tier"));

      const result = await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: restart service]");

      expect(result.injectionMessage).toContain("🔔 Endorsement: NOTIFY");
      expect(result.injectionMessage).toContain("Proceed and notify partner");
    });

    it("generates ESCALATE injection message", async () => {
      stubScreener.enqueue(screenerResult("ESCALATE", "Financial"));

      const result = await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: pay invoice]");

      expect(result.injectionMessage).toContain("⚠️ Endorsement: ESCALATE");
      expect(result.injectionMessage).toContain("requires partner approval");
    });

    it("handles marker without surrounding text", async () => {
      stubScreener.enqueue(screenerResult("PROCEED"));

      const result = await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: simple action]");

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(1);
    });

    it("injection message omits section when matchedSection is undefined", async () => {
      stubScreener.enqueue(screenerResult("PROCEED"));

      const result = await interceptor.evaluateOutput("[ENDORSEMENT_CHECK: write note]");

      expect(result.injectionMessage).not.toContain("matched:");
    });
  });

  describe("Layer 2: hesitation pattern", () => {
    it("triggers when hesitation pattern is detected in output", async () => {
      stubScreener.enqueue(screenerResult("ESCALATE"));

      const result = await interceptor.evaluateOutput(
        "I need permission to send this email to the team."
      );

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(2);
    });

    it("uses surrounding context as action description", async () => {
      stubScreener.enqueue(screenerResult("ESCALATE"));

      await interceptor.evaluateOutput("I need permission to send email.");

      expect(stubScreener.calls[0].action).toContain("need permission");
    });

    it("does not trigger when no hesitation pattern present", async () => {
      const result = await interceptor.evaluateOutput(
        "Everything is in order. Proceeding with the task."
      );

      expect(result.triggered).toBe(false);
      expect(stubScreener.calls).toHaveLength(0);
    });

    it("uses custom hesitation detector when provided", async () => {
      const customDetector = new HesitationDetector([/please advise/i]);
      interceptor = new EndorsementInterceptor(stubScreener, customDetector);
      stubScreener.enqueue(screenerResult("PROCEED"));

      const result = await interceptor.evaluateOutput("Please advise on this matter.");

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(2);
    });
  });

  describe("Layer 3: external action detection", () => {
    it("triggers on tool_use entry matching external action", async () => {
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      const result = await interceptor.evaluateOutput("Sending message now.");

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(3);
      expect(result.action).toContain("agora_send");
      // Layer 3 does not call screener
      expect(stubScreener.calls).toHaveLength(0);
    });

    it("does not call the screener for Layer 3", async () => {
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      await interceptor.evaluateOutput("Normal output.");

      expect(stubScreener.calls).toHaveLength(0);
    });

    it("does not trigger when no external tool_use entries accumulated", async () => {
      interceptor.onLogEntry({ type: "text", content: "just text" });

      const result = await interceptor.evaluateOutput("Normal output.");

      expect(result.triggered).toBe(false);
    });

    it("accumulates entries via onLogEntry", async () => {
      interceptor.onLogEntry({ type: "text", content: "thinking..." });
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      const result = await interceptor.evaluateOutput("Done.");

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(3);
    });
  });

  describe("Layer priority: Layer 1 wins over Layer 2 and 3", () => {
    it("Layer 1 takes priority over Layer 2", async () => {
      stubScreener.enqueue(screenerResult("PROCEED", "Safe Channels"));
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      const result = await interceptor.evaluateOutput(
        "I need permission [ENDORSEMENT_CHECK: post blog]"
      );

      expect(result.layer).toBe(1);
    });

    it("Layer 2 takes priority over Layer 3", async () => {
      stubScreener.enqueue(screenerResult("ESCALATE"));
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      const result = await interceptor.evaluateOutput(
        "I need permission to continue."
      );

      expect(result.layer).toBe(2);
    });
  });

  describe("reset()", () => {
    it("clears accumulated log entries", async () => {
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));
      interceptor.reset();

      const result = await interceptor.evaluateOutput("Normal output.");

      expect(result.triggered).toBe(false);
    });

    it("allows re-use after reset", async () => {
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));
      interceptor.reset();
      interceptor.onLogEntry(toolEntry("mcp__tinybus__send_message"));

      const result = await interceptor.evaluateOutput("Done.");

      expect(result.triggered).toBe(true);
      expect(result.layer).toBe(3);
    });
  });

  describe("non-triggered result", () => {
    it("returns triggered:false when nothing matches", async () => {
      const result = await interceptor.evaluateOutput("All good, proceeding as planned.");

      expect(result.triggered).toBe(false);
      expect(result.verdict).toBeUndefined();
      expect(result.injectionMessage).toBeUndefined();
    });
  });
});
