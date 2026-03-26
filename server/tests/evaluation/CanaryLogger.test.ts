import { CanaryLogger, CanaryRecord, readConvMdStats } from "../../src/evaluation/CanaryLogger";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";

describe("CanaryLogger", () => {
  let fs: InMemoryFileSystem;
  let logger: CanaryLogger;
  const filePath = "/data/canary-log.jsonl";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    logger = new CanaryLogger(fs, filePath);
  });

  const makeRecord = (overrides: Partial<CanaryRecord> = {}): CanaryRecord => ({
    timestamp: "2026-03-11T03:00:00.000Z",
    cycle: 42,
    launcher: "claude",
    candidateCount: 3,
    highPriorityConfidence: 87,
    parseErrors: 0,
    pass: true,
    ...overrides,
  });

  describe("recordCycle", () => {
    it("creates the data directory and appends a JSONL record", async () => {
      await logger.recordCycle(makeRecord());

      const content = await fs.readFile(filePath);
      const parsed = JSON.parse(content.trim()) as CanaryRecord;
      expect(parsed.cycle).toBe(42);
      expect(parsed.launcher).toBe("claude");
      expect(parsed.candidateCount).toBe(3);
      expect(parsed.pass).toBe(true);
    });

    it("appends multiple records as separate JSONL lines", async () => {
      await logger.recordCycle(makeRecord({ cycle: 1, candidateCount: 5 }));
      await logger.recordCycle(makeRecord({ cycle: 2, candidateCount: 0, pass: false }));

      const content = await fs.readFile(filePath);
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect((JSON.parse(lines[0]) as CanaryRecord).cycle).toBe(1);
      expect((JSON.parse(lines[0]) as CanaryRecord).candidateCount).toBe(5);
      expect((JSON.parse(lines[1]) as CanaryRecord).cycle).toBe(2);
      expect((JSON.parse(lines[1]) as CanaryRecord).pass).toBe(false);
    });

    it("creates directory if it does not exist", async () => {
      // No mkdir called beforehand — CanaryLogger should create the dir
      await logger.recordCycle(makeRecord());

      const content = await fs.readFile(filePath);
      expect(content.trim()).toBeTruthy();
    });

    it("records null highPriorityConfidence correctly", async () => {
      await logger.recordCycle(makeRecord({ highPriorityConfidence: null }));

      const content = await fs.readFile(filePath);
      const parsed = JSON.parse(content.trim()) as CanaryRecord;
      expect(parsed.highPriorityConfidence).toBeNull();
    });

    it("records parse errors and fail verdict correctly", async () => {
      await logger.recordCycle(makeRecord({ candidateCount: 0, parseErrors: 1, pass: false }));

      const content = await fs.readFile(filePath);
      const parsed = JSON.parse(content.trim()) as CanaryRecord;
      expect(parsed.parseErrors).toBe(1);
      expect(parsed.pass).toBe(false);
    });

    describe("CONV.md normalization", () => {
      it("computes cPerLine and cPerKb when convMdLines and convMdKb are provided", async () => {
        await logger.recordCycle(makeRecord({ candidateCount: 8, convMdLines: 81, convMdKb: 4.2 }));

        const content = await fs.readFile(filePath);
        const parsed = JSON.parse(content.trim()) as CanaryRecord;
        expect(parsed.convMdLines).toBe(81);
        expect(parsed.convMdKb).toBe(4.2);
        expect(parsed.cPerLine).toBeCloseTo(0.099, 2);
        expect(parsed.cPerKb).toBeCloseTo(1.9, 1);
      });

      it("omits cPerLine and postCompaction when convMdLines is absent", async () => {
        await logger.recordCycle(makeRecord({ candidateCount: 8 }));

        const content = await fs.readFile(filePath);
        const parsed = JSON.parse(content.trim()) as CanaryRecord;
        expect(parsed.cPerLine).toBeUndefined();
        expect(parsed.postCompaction).toBeUndefined();
      });

      it("omits cPerKb when convMdKb is absent", async () => {
        await logger.recordCycle(makeRecord({ candidateCount: 8, convMdLines: 81 }));

        const content = await fs.readFile(filePath);
        const parsed = JSON.parse(content.trim()) as CanaryRecord;
        expect(parsed.cPerKb).toBeUndefined();
      });

      it("sets postCompaction=false on first run (no previous lines to compare)", async () => {
        await logger.recordCycle(makeRecord({ candidateCount: 8, convMdLines: 81, convMdKb: 4.2 }));

        const content = await fs.readFile(filePath);
        const parsed = JSON.parse(content.trim()) as CanaryRecord;
        expect(parsed.postCompaction).toBeUndefined();
      });

      it("sets postCompaction=true when convMdLines drops below previous run", async () => {
        await logger.recordCycle(makeRecord({ cycle: 1, candidateCount: 9, convMdLines: 81, convMdKb: 4.2 }));
        await logger.recordCycle(makeRecord({ cycle: 2, candidateCount: 4, convMdLines: 57, convMdKb: 2.8 }));

        const content = await fs.readFile(filePath);
        const lines = content.trim().split("\n");
        const second = JSON.parse(lines[1]) as CanaryRecord;
        expect(second.postCompaction).toBe(true);
      });

      it("sets postCompaction=false when convMdLines equals or grows from previous run", async () => {
        await logger.recordCycle(makeRecord({ cycle: 1, candidateCount: 8, convMdLines: 60, convMdKb: 3.1 }));
        await logger.recordCycle(makeRecord({ cycle: 2, candidateCount: 9, convMdLines: 81, convMdKb: 4.2 }));

        const content = await fs.readFile(filePath);
        const lines = content.trim().split("\n");
        const second = JSON.parse(lines[1]) as CanaryRecord;
        expect(second.postCompaction).toBe(false);
      });

      it("does not compute cPerLine when convMdLines is 0", async () => {
        await logger.recordCycle(makeRecord({ candidateCount: 8, convMdLines: 0, convMdKb: 0 }));

        const content = await fs.readFile(filePath);
        const parsed = JSON.parse(content.trim()) as CanaryRecord;
        expect(parsed.cPerLine).toBeUndefined();
        expect(parsed.cPerKb).toBeUndefined();
      });
    });
  });

  describe("readConvMdStats", () => {
    const convMdPath = "/substrate/CONVERSATION.md";

    it("returns line count and KB when file exists", async () => {
      // 3 lines, known byte size
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(convMdPath, "line1\nline2\nline3");

      const stats = await readConvMdStats(fs, convMdPath);
      expect(stats).not.toBeNull();
      expect(stats!.lines).toBe(3);
      expect(stats!.kb).toBeGreaterThan(0);
    });

    it("returns null when file does not exist", async () => {
      const stats = await readConvMdStats(fs, "/nonexistent/CONVERSATION.md");
      expect(stats).toBeNull();
    });
  });
});
