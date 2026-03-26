import { CanaryLogger, CanaryRecord } from "../../src/evaluation/CanaryLogger";
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
  });

  describe("lastResultPath", () => {
    const lastResultPath = "/substrate/canary_last_result.json";

    beforeEach(() => {
      fs = new InMemoryFileSystem();
      logger = new CanaryLogger(fs, filePath, lastResultPath);
    });

    it("writes the latest record as pretty JSON to lastResultPath", async () => {
      await logger.recordCycle(makeRecord());

      const content = await fs.readFile(lastResultPath);
      const parsed = JSON.parse(content) as CanaryRecord;
      expect(parsed.cycle).toBe(42);
      expect(parsed.pass).toBe(true);
    });

    it("overwrites lastResultPath on each call, keeping only the most recent record", async () => {
      await logger.recordCycle(makeRecord({ cycle: 1, pass: true }));
      await logger.recordCycle(makeRecord({ cycle: 2, pass: false }));

      const content = await fs.readFile(lastResultPath);
      const parsed = JSON.parse(content) as CanaryRecord;
      expect(parsed.cycle).toBe(2);
      expect(parsed.pass).toBe(false);
    });

    it("still appends all records to the JSONL log file", async () => {
      await logger.recordCycle(makeRecord({ cycle: 1 }));
      await logger.recordCycle(makeRecord({ cycle: 2 }));

      const content = await fs.readFile(filePath);
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
    });

    it("creates the lastResultPath directory if it does not exist", async () => {
      const deepLastResultPath = "/new/deep/dir/canary_last_result.json";
      const loggerWithDeepPath = new CanaryLogger(fs, filePath, deepLastResultPath);

      await loggerWithDeepPath.recordCycle(makeRecord());

      const content = await fs.readFile(deepLastResultPath);
      expect(JSON.parse(content)).toBeTruthy();
    });

    it("does not write lastResultPath when not provided", async () => {
      const loggerWithoutLast = new CanaryLogger(fs, filePath);
      await loggerWithoutLast.recordCycle(makeRecord());

      await expect(fs.readFile(lastResultPath)).rejects.toThrow();
    });
  });
});
