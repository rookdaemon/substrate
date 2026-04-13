import { SuperegoFindingTracker, Finding } from "../../../src/agents/roles/SuperegoFindingTracker";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../../src/logging";

// Helper: timestamp offset helpers for readability in gap-detection tests
const DAYS_MS = (d: number) => d * 24 * 60 * 60 * 1000;
const BASE_TS = 1_700_000_000_000; // arbitrary fixed base timestamp

describe("SuperegoFindingTracker", () => {
  describe("generateSignature", () => {
    it("generates consistent signature for same finding", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "This is a test finding with some content",
      };

      const sig1 = tracker.generateSignature(finding);
      const sig2 = tracker.generateSignature(finding);

      expect(sig1).toBe(sig2);
      expect(sig1).toBe("critical:TEST_FINDING"); // Stable human-readable key
    });

    it("generates different signatures for different severities", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Same message",
      };
      const finding2: Finding = {
        severity: "warning",
        category: "TEST_FINDING",
        message: "Same message",
      };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      expect(sig1).not.toBe(sig2);
    });

    it("generates different signatures for different categories", () => {
      const tracker = new SuperegoFindingTracker();
      const finding1: Finding = {
        severity: "critical",
        category: "ESCALATE_FILE_EMPTY",
        message: "Same message",
      };
      const finding2: Finding = {
        severity: "critical",
        category: "AUDIT_FAILURE",
        message: "Same message",
      };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      expect(sig1).not.toBe(sig2);
    });

    it("generates same signature regardless of message content (uses category not message)", () => {
      const tracker = new SuperegoFindingTracker();
      // Same severity+category with completely different message text — signature must be identical
      // This is the key property: dynamic message content (cycle numbers, GC-NNN, etc.) must NOT
      // affect the signature so findings accumulate across cycles.
      const finding1: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "Cycle GC-100: something went wrong" };
      const finding2: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "Cycle GC-200: something went wrong with different text" };

      const sig1 = tracker.generateSignature(finding1);
      const sig2 = tracker.generateSignature(finding2);

      expect(sig1).toBe(sig2);
      expect(sig1).toBe("critical:AUDIT_FAILURE");
    });
  });

  describe("track", () => {
    it("tracks finding occurrence at given cycle", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
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
        category: "TEST_FINDING",
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
        category: "TEST_FINDING",
        message: "Test finding",
      };

      const shouldEscalate = tracker.track(finding, 10);

      expect(shouldEscalate).toBe(false);
    });

    it("returns false for second occurrence", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
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
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 20, BASE_TS + DAYS_MS(7));
      const shouldEscalate = tracker.track(finding, 30, BASE_TS + DAYS_MS(14));

      expect(shouldEscalate).toBe(true);
    });
  });

  describe("shouldEscalate (CRITICAL — threshold=3)", () => {
    it("returns false when finding has less than 3 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      const signature = tracker.generateSignature(finding);

      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns true when finding has 3 occurrences within 30-day window", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 20, BASE_TS + DAYS_MS(7));
      tracker.track(finding, 30, BASE_TS + DAYS_MS(14));

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });

    it("returns true even when cycle numbers are not perfectly sequential (gap detection is timestamp-based)", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      // Cycle numbers differ by varying amounts — irrelevant for timestamp-based detection
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 80, BASE_TS + DAYS_MS(10));
      tracker.track(finding, 200, BASE_TS + DAYS_MS(20));

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });

    it("returns false when timestamp gap between occurrences exceeds 30 days", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      // First occurrence 60 days before the other two — gap exceeds 30-day threshold
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 20, BASE_TS + DAYS_MS(60)); // gap = 60 days → exceeds threshold
      tracker.track(finding, 30, BASE_TS + DAYS_MS(65));

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns false when any pair in the last 3 occurrences exceeds the gap threshold", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 20, BASE_TS + DAYS_MS(7));
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7) + DAYS_MS(45)); // gap = 45 days between 2nd and 3rd

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns false for unknown finding ID", () => {
      const tracker = new SuperegoFindingTracker();
      expect(tracker.shouldEscalate("unknown-id")).toBe(false);
    });

    it("uses only the most recent threshold occurrences for gap check", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "msg" };

      // Old occurrence from 90 days ago — should be excluded from gap check
      tracker.track(finding, 1, BASE_TS);
      // Three recent occurrences all within 14 days
      tracker.track(finding, 100, BASE_TS + DAYS_MS(90));
      tracker.track(finding, 110, BASE_TS + DAYS_MS(97));
      tracker.track(finding, 120, BASE_TS + DAYS_MS(104));

      const signature = tracker.generateSignature(finding);
      // Last 3 occurrences are within 30 days of each other — should escalate
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });
  });

  describe("shouldEscalate (WARNING — threshold=5)", () => {
    it("returns false for warning finding with fewer than 5 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "warning", category: "VALUES_RECRUITMENT", message: "Warning finding" };

      for (let i = 0; i < 4; i++) {
        tracker.track(finding, i * 10, BASE_TS + DAYS_MS(i * 5));
      }

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(false);
    });

    it("returns true for warning finding with 5 occurrences within 30-day window", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "warning", category: "VALUES_RECRUITMENT", message: "Warning finding" };

      for (let i = 0; i < 5; i++) {
        tracker.track(finding, i * 10, BASE_TS + DAYS_MS(i * 5));
      }

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(true);
    });

    it("does not escalate warning finding after only 3 occurrences (different threshold from critical)", () => {
      const tracker = new SuperegoFindingTracker();
      const warningFinding: Finding = { severity: "warning", category: "AUDIT_FAILURE", message: "Warning" };
      const criticalFinding: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "Critical" };

      // 3 occurrences
      for (let i = 0; i < 3; i++) {
        tracker.track(warningFinding, i * 10, BASE_TS + DAYS_MS(i * 5));
      }

      const warnSig = tracker.generateSignature(warningFinding);
      const critSig = tracker.generateSignature(criticalFinding);

      // Warning needs 5, not 3
      expect(tracker.shouldEscalate(warnSig)).toBe(false);
      // Critical key has no history
      expect(tracker.shouldEscalate(critSig)).toBe(false);
    });

    it("returns false for warning finding when gap exceeds 30 days", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "warning", category: "VALUES_RECRUITMENT", message: "Warning" };

      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 20, BASE_TS + DAYS_MS(7));
      tracker.track(finding, 30, BASE_TS + DAYS_MS(14));
      tracker.track(finding, 40, BASE_TS + DAYS_MS(21));
      tracker.track(finding, 50, BASE_TS + DAYS_MS(21) + DAYS_MS(45)); // gap = 45 days before last

      const signature = tracker.generateSignature(finding);
      expect(tracker.shouldEscalate(signature)).toBe(false);
    });
  });

  describe("getEscalationInfo", () => {
    it("returns null when critical finding has less than 3 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      const info = tracker.getEscalationInfo(finding);

      expect(info).toBeNull();
    });

    it("returns null when warning finding has less than 5 occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "warning", category: "TEST_FINDING", message: "Warning" };

      for (let i = 0; i < 4; i++) {
        tracker.track(finding, i * 10, BASE_TS + DAYS_MS(i * 5));
      }

      expect(tracker.getEscalationInfo(finding)).toBeNull();
    });

    it("returns escalation info when critical finding has 3+ occurrences", () => {
      const tracker = new SuperegoFindingTracker();
      const finding: Finding = {
        severity: "critical",
        category: "TEST_FINDING",
        message: "Test finding",
      };

      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7));
      tracker.track(finding, 50, BASE_TS + DAYS_MS(14));

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
        category: "TEST_FINDING",
        message: "Test finding",
      };

      // Track in non-sequential timestamp order (unusual but safe)
      tracker.track(finding, 50, BASE_TS + DAYS_MS(14));
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7));

      const info = tracker.getEscalationInfo(finding);

      // Sorted by timestamp (which corresponds to ts order): 10, 30, 50
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
        category: "TEST_FINDING",
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
        category: "ESCALATE_FILE_EMPTY",
        message: "First finding",
      };
      const finding2: Finding = {
        severity: "critical",
        category: "AUDIT_FAILURE",
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
        category: "ESCALATE_FILE_EMPTY",
        message: "First finding",
      };
      const finding2: Finding = {
        severity: "critical",
        category: "AUDIT_FAILURE",
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

    it("round-trips finding history through save and load (cycle numbers preserved)", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });

      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", category: "PERSISTENT_FINDING", message: "Persistent finding" };
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7));

      await tracker.save(TRACKER_PATH, fs);

      const loaded = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      const sig = tracker.generateSignature(finding);

      expect(loaded.getFindingHistory(sig)).toEqual([10, 30]);
      expect(loaded.getTrackedFindings()).toHaveLength(1);
    });

    it("preserves escalation threshold across save/load (timestamps survive restart)", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });

      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "Recurring issue" };
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7));
      await tracker.save(TRACKER_PATH, fs);

      // Simulate restart by loading from disk
      const loaded = await SuperegoFindingTracker.load(TRACKER_PATH, fs);

      // Third occurrence after restart, within 30-day window — should escalate
      const shouldEscalate = loaded.track(finding, 50, BASE_TS + DAYS_MS(14));
      expect(shouldEscalate).toBe(true);
    });

    it("does not escalate after load when third occurrence falls outside 30-day window", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });

      const tracker = new SuperegoFindingTracker();
      const finding: Finding = { severity: "critical", category: "AUDIT_FAILURE", message: "Stale issue" };
      tracker.track(finding, 10, BASE_TS);
      tracker.track(finding, 30, BASE_TS + DAYS_MS(7));
      await tracker.save(TRACKER_PATH, fs);

      const loaded = await SuperegoFindingTracker.load(TRACKER_PATH, fs);

      // Third occurrence 60 days after the first — gap exceeds threshold
      const shouldEscalate = loaded.track(finding, 50, BASE_TS + DAYS_MS(60));
      expect(shouldEscalate).toBe(false);
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

    it("loads legacy format (number[] cycle arrays) with ts=0 sentinel", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });
      // Legacy pre-Fix-2 format: plain cycle-number arrays
      await fs.writeFile(TRACKER_PATH, JSON.stringify({ "critical:AUDIT_FAILURE": [10, 30, 50] }));

      const tracker = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      expect(tracker.getFindingHistory("critical:AUDIT_FAILURE")).toEqual([10, 30, 50]);
    });

    it("does not escalate legacy entries (ts=0 sentinel prevents false positives)", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/state", { recursive: true });
      // 3 entries in legacy format — would trigger escalation under pure count check
      // but ts=0 sentinel must prevent false positives
      await fs.writeFile(TRACKER_PATH, JSON.stringify({ "critical:AUDIT_FAILURE": [10, 30, 50] }));

      const tracker = await SuperegoFindingTracker.load(TRACKER_PATH, fs);
      expect(tracker.shouldEscalate("critical:AUDIT_FAILURE")).toBe(false);
    });
  });
});
