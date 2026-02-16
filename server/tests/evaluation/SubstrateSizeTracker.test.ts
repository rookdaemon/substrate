import { SubstrateSizeTracker } from "../../src/evaluation/SubstrateSizeTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("SubstrateSizeTracker", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let tracker: SubstrateSizeTracker;
  const substratePath = "/test/substrate";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-16T12:00:00Z"));
    tracker = new SubstrateSizeTracker(fs, clock, substratePath);
    
    // Create substrate directory
    await fs.mkdir(substratePath, { recursive: true });
  });

  async function createTestFiles() {
    await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n" + "line\n".repeat(80)); // 82 lines
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n" + "entry\n".repeat(150)); // 152 lines
    await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n" + "fact\n".repeat(100)); // 102 lines
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, "# Conversation\n" + "msg\n".repeat(250)); // 252 lines
  }

  describe("recordSnapshot", () => {
    it("should create metrics file on first snapshot", async () => {
      await createTestFiles();
      await tracker.recordSnapshot();

      const content = await fs.readFile(`${substratePath}/.metrics/substrate_sizes.jsonl`);
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);
      
      const snapshot = JSON.parse(lines[0]);
      expect(snapshot.timestamp).toBe("2026-02-16T12:00:00.000Z");
      expect(snapshot.files["PLAN.md"]).toBe(82);
      expect(snapshot.files["PROGRESS.md"]).toBe(152);
      expect(snapshot.files["MEMORY.md"]).toBe(102);
      expect(snapshot.files["CONVERSATION.md"]).toBe(252);
      expect(snapshot.totalBytes).toBeGreaterThan(0);
    });

    it("should handle missing files gracefully", async () => {
      // Only create PLAN.md
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\nSome content\n");
      
      await tracker.recordSnapshot();

      const snapshot = await tracker.getLatestSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files["PLAN.md"]).toBeGreaterThan(0);
      expect(snapshot!.files["PROGRESS.md"]).toBe(0); // Missing file
      expect(snapshot!.files["MEMORY.md"]).toBe(0);
    });

    it("should append multiple snapshots", async () => {
      await createTestFiles();
      await tracker.recordSnapshot();
      
      // Modify files and take another snapshot
      clock.setNow(new Date("2026-02-17T12:00:00Z"));
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n" + "line\n".repeat(120)); // 122 lines
      await tracker.recordSnapshot();

      const content = await fs.readFile(`${substratePath}/.metrics/substrate_sizes.jsonl`);
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);
      
      const snapshots = lines.map(line => JSON.parse(line));
      expect(snapshots[0].files["PLAN.md"]).toBe(82);
      expect(snapshots[1].files["PLAN.md"]).toBe(122);
    });
  });

  describe("getHistory", () => {
    it("should return empty array when no snapshots exist", async () => {
      const history = await tracker.getHistory();
      expect(history).toEqual([]);
    });

    it("should return all snapshots", async () => {
      await createTestFiles();
      await tracker.recordSnapshot();
      
      clock.setNow(new Date("2026-02-17T12:00:00Z"));
      await tracker.recordSnapshot();

      const history = await tracker.getHistory();
      expect(history.length).toBe(2);
    });
  });

  describe("getCurrentStatus", () => {
    it("should return OK status when under target", async () => {
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n" + "line\n".repeat(50)); // 52 lines, target 100
      
      const status = await tracker.getCurrentStatus();
      
      expect(status["PLAN.md"].current).toBe(52);
      expect(status["PLAN.md"].target).toBe(100);
      expect(status["PLAN.md"].status).toBe("OK");
      expect(status["PLAN.md"].alert).toBeUndefined();
    });

    it("should return WARNING status when 1.5x-2x target", async () => {
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n" + "line\n".repeat(160)); // 162 lines, target 100
      
      const status = await tracker.getCurrentStatus();
      
      expect(status["PLAN.md"].current).toBe(162);
      expect(status["PLAN.md"].status).toBe("WARNING");
      expect(status["PLAN.md"].alert).toContain("1.6x target");
    });

    it("should return CRITICAL status when over 2x target", async () => {
      await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n" + "line\n".repeat(500)); // 502 lines, target 200
      
      const status = await tracker.getCurrentStatus();
      
      expect(status["PROGRESS.md"].current).toBe(502);
      expect(status["PROGRESS.md"].status).toBe("CRITICAL");
      expect(status["PROGRESS.md"].alert).toContain("2.5x target");
    });

    it("should check all substrate files", async () => {
      const status = await tracker.getCurrentStatus();
      
      // Verify all expected files are checked
      const expectedFiles = [
        "PLAN.md", "PROGRESS.md", "MEMORY.md", "CONVERSATION.md",
        "HABITS.md", "SKILLS.md", "VALUES.md", "ID.md",
        "SECURITY.md", "CHARTER.md", "SUPEREGO.md", "CLAUDE.md"
      ];
      
      for (const file of expectedFiles) {
        expect(status[file]).toBeDefined();
        expect(status[file].target).toBeGreaterThan(0);
      }
    });
  });

  describe("getLatestSnapshot", () => {
    it("should return null when no snapshots exist", async () => {
      const latest = await tracker.getLatestSnapshot();
      expect(latest).toBeNull();
    });

    it("should return most recent snapshot", async () => {
      await createTestFiles();
      await tracker.recordSnapshot();
      
      clock.setNow(new Date("2026-02-17T12:00:00Z"));
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n" + "line\n".repeat(90));
      await tracker.recordSnapshot();

      const latest = await tracker.getLatestSnapshot();
      expect(latest).not.toBeNull();
      expect(latest!.timestamp).toBe("2026-02-17T12:00:00.000Z");
      expect(latest!.files["PLAN.md"]).toBe(92); // Modified version
    });
  });

  describe("clear", () => {
    it("should remove metrics file", async () => {
      await createTestFiles();
      await tracker.recordSnapshot();
      
      const existsBefore = await fs.exists(`${substratePath}/.metrics/substrate_sizes.jsonl`);
      expect(existsBefore).toBe(true);

      await tracker.clear();
      
      const existsAfter = await fs.exists(`${substratePath}/.metrics/substrate_sizes.jsonl`);
      expect(existsAfter).toBe(false);
    });
  });
});
