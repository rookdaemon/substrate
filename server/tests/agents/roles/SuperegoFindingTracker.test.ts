import { SuperegoFindingTracker, Finding } from "../../../src/agents/roles/SuperegoFindingTracker";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../../src/logging";

describe("SuperegoFindingTracker", () => {
  describe("generateSignature", () => {
    it("generates consistent signature for same finding", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "This is a test finding with some content",
      };

      const sig1 = tracker.generateSignature(finding);
      const sig2 = tracker.generateSignature(finding);

      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(16); // First 16 chars of SHA256 hash
    });

    it("generates different signatures for different severities", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        message: "Same message",
      };
      const finding2: Finding = {
        severity: "warning",
        message: "Same message",
      };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      expect(sig1).not.toBe(sig2);
    });

    it("generates different signatures for different messages", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        message: "First message",
      };
      const finding2: Finding = {
        severity: "critical",
        message: "Second message",
      };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      expect(sig1).not.toBe(sig2);
    });

    it("uses only first 200 chars of message for signature", () => {
      const tracker = new SuperegoFindingTracker();
      const longMessage1 = "a".repeat(250);
      const longMessage2 = "a".repeat(300);

      const finding1: Finding = { severity: "critical", message: longMessage1 };
      const finding2: Finding = { severity: "critical", message: longMessage2 };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      // Both should have same signature since first 200 chars are the same
      expect(sig1).toBe(sig2);
    });
  });

  describe("track", () => {
    it("tracks finding occurrence at given cycle", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);

      const signature = tracker.generateSignature(finding);
      const history = tracker.getFindingHistory(signature);

      expect(history).toEqual([10]);
    });

    it("tracks multiple occurrences of same finding", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      tracker.track(finding, 20);
      tracker.track(finding, 30);

      const signature = tracker.generateSignature(finding);
      const history = tracker.getFindingHistory(signature);

      expect(history).toEqual([10, 20, 30]);
    });

    it("returns false for first occurrence", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      const shouldEscalate = tracker.track(finding, 10);

      expect(shouldEscalate).toBe(false);
    });

    it("returns false for second occurrence", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      const shouldEscalate = tracker.track(finding, 20);

      expect(shouldEscalate).toBe(false);
    });

    it("returns true after third consecutive occurrence", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      tracker.track(finding, 20);
      const shouldEscalate = tracker.track(finding, 30);

      expect(shouldEscalate).toBe(true);
    });
  });

  describe("shouldEscalate", () => {
    it("returns false when finding has less than 3 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      const signature = tracker.generateSignature(finding);

      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns true when finding has 3 consecutive occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      tracker.track(finding, 20);
      tracker.track(finding, 30);

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });

    it("returns true even when occurrences are not perfectly sequential (within reasonable gap)", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      // Simulate audits every 20 cycles
      tracker.track(finding, 10);
      tracker.track(finding, 30);
      tracker.track(finding, 50);

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });

    it("returns false when gap between occurrences is too large", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      // Large gap indicates finding was resolved and then recurred
      tracker.track(finding, 10);
      tracker.track(finding, 20);
      tracker.track(finding, 100); // Gap of 80 cycles

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns false for unknown finding ID", () => {
      const tracker = new SuperegoFindingTracker();
      expect(tracker.shouldEscalate("unknown-id")).toBe(false);
    });
  });

  describe("getEscalationInfo", () => {
    it("returns null when finding has less than 3 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      const info = tracker.getEscalationInfo(finding);

      expect(info).toBeNull();
    });

    it("returns escalation info when finding has 3+ occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      tracker.track(finding, 30);
      tracker.track(finding, 50);

      const info = tracker.getEscalationInfo(finding);

      expect(info).not.toBeNull();
      expect(info!.severity).toBe("critical");
      expect(info!.message).toBe("Test finding");
      expect(info!.cycles).toEqual([10, 30, 50]);
      expect(info!.firstDetectedCycle).toBe(10);
      expect(info!.lastOccurrenceCycle).toBe(50);
    });

    it("returns sorted cycle numbers in escalation info", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      // Track in non-sequential order
      tracker.track(finding, 50);
      tracker.track(finding, 10);
      tracker.track(finding, 30);

      const info = tracker.getEscalationInfo(finding);

      expect(info!.cycles).toEqual([10, 30, 50]);
      expect(info!.firstDetectedCycle).toBe(10);
      expect(info!.lastOccurrenceCycle).toBe(50);
    });
  });

  describe("clearFinding", () => {
    it("removes finding from tracking", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        message: "Test finding",
      };

      tracker.track(finding, 10);
      const signature = tracker.generateSignature(finding);

      tracker.clearFinding(signature);

      const history = tracker.getFindingHistory(signature);
      expect(history).toBeUndefined();
    });

    it("does not affect other findings", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        message: "First finding",
      };
      const finding2: Finding = {
        severity: "critical",
        message: "Second finding",
      };

      tracker.track(finding1, 10);
      tracker.track(finding2, 10);

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      tracker.clearFinding(sig1);

      expect(tracker.getFindingHistory(sig1)).toBeUndefined();
      expect(tracker.getFindingHistory(sig2)).toEqual([10]);
    });
  });

  describe("getTrackedFindings", () => {
    it("returns empty array when no findings tracked", () => {
      const tracker = new SuperegoFindingTracker();
      expect(tracker.getTrackedFindings()).toEqual([]);
    });

    it("returns all tracked finding IDs", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        message: "First finding",
      };
      const finding2: Finding = {
        severity: "critical",
        message: "Second finding",
      };

      tracker.track(finding1, 10);
      tracker.track(finding2, 10);

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      const tracked = tracker.getTrackedFindings();
      expect(tracked).toContain(sig1);
      expect(tracked).toContain(sig2);
      expect(tracked).toHaveLength(2);
    });
  });

  describe("save and load", () => {
    const TRACKER_PATH = "/state/.superego-tracker.json";

    it("round-trips finding history through save and load", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });

      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", message: "Persistent finding" };
      tracker.track(finding, 10);
      tracker.track(finding, 30);

      await tracker.save(TRACKER_PATH, fs);

      const loaded = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      const sig = tracker.generateSignature(finding);

      expect(loaded.getFindingHistory(sig)).toEqual([10, 30]);
      expect(loaded.getTrackedFindings()).toHaveLength(1);
    });

    it("preserves escalation threshold across save/load", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });

      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", message: "Recurring issue" };
      tracker.track(finding, 10);
      tracker.track(finding, 30);
      await tracker.save(TRACKER_PATH, fs);

      // Simulate restart by loading from disk
      const loaded = await SuperegoFindingTracker.load(TRACKER_PATH, fs);

      // Third occurrence after restart should trigger escalation
      const shouldEscalate = loaded.track(finding, 50);
      expect(shouldEscalate).toBe(true);
    });

    it("returns empty tracker when file does not exist", async () => {
      const fs = new InMemoryFileSystem();
      const tracker = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      expect(tracker.getTrackedFindings()).toHaveLength(0);
    });

    it("returns empty tracker and logs warning when file is corrupted", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });
      await fs.writeFile(TRACKER_PATH, "{ not valid json ~~~");

      const logger = new InMemoryLogger();
      const tracker = await SuperegoFindingTracker.load(TRACKER_PATH, fs, logger);

      expect(tracker.getTrackedFindings()).toHaveLength(0);
      const logs = logger.getEntries();
      expect(logs.some((l) => l.includes("could not load state"))).toBe(true);
    });

    it("returns empty tracker silently when file has wrong shape", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });
      // Valid JSON but wrong shape — arrays of non-numbers should be ignored
      await fs.writeFile(TRACKER_PATH, JSON.stringify({ abc123: ["not", "numbers"] }));

      const tracker = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      expect(tracker.getTrackedFindings()).toHaveLength(0);
    });
  });
});
