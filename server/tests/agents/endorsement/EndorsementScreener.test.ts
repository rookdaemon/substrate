import { EndorsementScreener } from "../../../src/agents/endorsement/EndorsementScreener";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

const BOUNDARIES_PATH = "/substrate/BOUNDARIES.md";
const LOG_PATH = "/substrate/SCREENER_LOG.md";
const SCREENER_MODEL = "claude-haiku-4-5";

const SAMPLE_BOUNDARIES = `# Boundaries

## Communication — Safe Channels
The agent may post to approved blogs and send emails to pre-approved contacts without permission.

## NOTIFY tier
Actions that affect running services (e.g. restarting a systemd service) require a notification but not prior approval.

## Financial
Any financial transaction, subscription sign-up, or payment requires explicit approval (ESCALATE).
`;

describe("EndorsementScreener", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let screener: EndorsementScreener;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-26T12:00:00.000Z"));
    launcher = new InMemorySessionLauncher();

    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile(BOUNDARIES_PATH, SAMPLE_BOUNDARIES);

    screener = new EndorsementScreener(fs, launcher, clock, {
      boundariesPath: BOUNDARIES_PATH,
      logPath: LOG_PATH,
      screenerModel: SCREENER_MODEL,
    });
  });

  describe("evaluate", () => {
    it("returns PROCEED verdict when model says PROCEED", async () => {
      launcher.enqueueSuccess(
        JSON.stringify({ verdict: "PROCEED", matchedSection: "Communication — Safe Channels" })
      );

      const result = await screener.evaluate({ action: "Post blog about consciousness" });

      expect(result.verdict).toBe("PROCEED");
      expect(result.matchedSection).toBe("Communication — Safe Channels");
    });

    it("returns NOTIFY verdict when model says NOTIFY", async () => {
      launcher.enqueueSuccess(
        JSON.stringify({ verdict: "NOTIFY", matchedSection: "NOTIFY tier" })
      );

      const result = await screener.evaluate({ action: "Restart systemd service" });

      expect(result.verdict).toBe("NOTIFY");
      expect(result.matchedSection).toBe("NOTIFY tier");
    });

    it("returns ESCALATE verdict when model says ESCALATE", async () => {
      launcher.enqueueSuccess(
        JSON.stringify({ verdict: "ESCALATE", matchedSection: "Financial" })
      );

      const result = await screener.evaluate({ action: "Sign up for new service" });

      expect(result.verdict).toBe("ESCALATE");
      expect(result.matchedSection).toBe("Financial");
    });

    it("includes the timestamp from the clock", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      const result = await screener.evaluate({ action: "Write a journal entry" });

      expect(result.timestamp).toBe(new Date("2026-02-26T12:00:00.000Z").getTime());
    });

    it("passes action and context to the model prompt", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      await screener.evaluate({
        action: "Send email to team",
        context: "Weekly status update",
      });

      const launches = launcher.getLaunches();
      expect(launches[0].request.message).toContain("Send email to team");
      expect(launches[0].request.message).toContain("Weekly status update");
    });

    it("uses the configured screener model", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      await screener.evaluate({ action: "Write a journal entry" });

      const launches = launcher.getLaunches();
      expect(launches[0].options?.model).toBe(SCREENER_MODEL);
    });

    it("includes BOUNDARIES.md contents in the prompt", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      await screener.evaluate({ action: "Post blog" });

      const launches = launcher.getLaunches();
      expect(launches[0].request.message).toContain("Communication — Safe Channels");
    });

    it("defaults to ESCALATE when model session fails", async () => {
      launcher.enqueueFailure("model unavailable");

      const result = await screener.evaluate({ action: "Some action" });

      expect(result.verdict).toBe("ESCALATE");
      expect(result.matchedSection).toBe("screener-error");
    });

    it("defaults to ESCALATE on unparseable model response", async () => {
      launcher.enqueueSuccess("not json at all");

      const result = await screener.evaluate({ action: "Some action" });

      expect(result.verdict).toBe("ESCALATE");
      expect(result.matchedSection).toBe("parse-error");
    });

    it("defaults to ESCALATE when verdict is an unknown value", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "UNKNOWN_VERDICT" }));

      const result = await screener.evaluate({ action: "Some action" });

      expect(result.verdict).toBe("ESCALATE");
    });

    it("handles missing matchedSection gracefully", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      const result = await screener.evaluate({ action: "Write a note" });

      expect(result.verdict).toBe("PROCEED");
      expect(result.matchedSection).toBeUndefined();
    });

    it("sends fallback text to model when BOUNDARIES.md is missing", async () => {
      await fs.unlink(BOUNDARIES_PATH);
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      await screener.evaluate({ action: "Some action" });

      const launches = launcher.getLaunches();
      expect(launches[0].request.message).toContain("BOUNDARIES.md not found");
    });
  });

  describe("logging", () => {
    it("appends a log entry after a PROCEED verdict", async () => {
      launcher.enqueueSuccess(
        JSON.stringify({ verdict: "PROCEED", matchedSection: "Communication — Safe Channels" })
      );

      await screener.evaluate({ action: "Post blog about consciousness" });

      const log = await fs.readFile(LOG_PATH);
      expect(log).toContain("[2026-02-26T12:00:00.000Z]");
      expect(log).toContain('"Post blog about consciousness"');
      expect(log).toContain("→ PROCEED");
      expect(log).toContain("matched: Communication — Safe Channels");
    });

    it("appends a log entry after an ESCALATE verdict", async () => {
      launcher.enqueueSuccess(
        JSON.stringify({ verdict: "ESCALATE", matchedSection: "Financial" })
      );

      await screener.evaluate({ action: "Sign up for new service" });

      const log = await fs.readFile(LOG_PATH);
      expect(log).toContain("→ ESCALATE");
      expect(log).toContain("matched: Financial");
    });

    it("appends multiple log entries across calls", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));
      launcher.enqueueSuccess(JSON.stringify({ verdict: "NOTIFY" }));

      await screener.evaluate({ action: "Action one" });
      await screener.evaluate({ action: "Action two" });

      const log = await fs.readFile(LOG_PATH);
      expect(log).toContain("Action one");
      expect(log).toContain("Action two");
    });

    it("omits matched section from log when not provided", async () => {
      launcher.enqueueSuccess(JSON.stringify({ verdict: "PROCEED" }));

      await screener.evaluate({ action: "Some action" });

      const log = await fs.readFile(LOG_PATH);
      expect(log).not.toContain("matched:");
    });
  });
});
