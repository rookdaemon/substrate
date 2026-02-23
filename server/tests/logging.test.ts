import { InMemoryLogger, FileLogger } from "../src/logging";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("InMemoryLogger", () => {
  it("captures debug entries", () => {
    const logger = new InMemoryLogger();

    logger.debug("hello world");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe("hello world");
  });

  it("captures multiple entries in order", () => {
    const logger = new InMemoryLogger();

    logger.debug("first");
    logger.debug("second");
    logger.debug("third");

    expect(logger.getEntries()).toEqual(["first", "second", "third"]);
  });

  it("starts with empty entries", () => {
    const logger = new InMemoryLogger();
    expect(logger.getEntries()).toEqual([]);
  });

  it("captures verbose entries separately", () => {
    const logger = new InMemoryLogger();

    logger.verbose("secret payload");

    expect(logger.getEntries()).toHaveLength(0);
    expect(logger.getVerboseEntries()).toEqual(["secret payload"]);
  });

  it("keeps debug and verbose entries independent", () => {
    const logger = new InMemoryLogger();

    logger.debug("info event");
    logger.verbose("payload data");

    expect(logger.getEntries()).toEqual(["info event"]);
    expect(logger.getVerboseEntries()).toEqual(["payload data"]);
  });
});

describe("FileLogger", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
    logPath = path.join(tmpDir, "debug.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes debug entries to file", () => {
    const logger = new FileLogger(logPath);

    logger.debug("test message");

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("test message");
  });

  it("prefixes entries with ISO timestamp", () => {
    const logger = new FileLogger(logPath);

    logger.debug("timestamped");

    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const entryLine = lines.find(l => l.includes("timestamped"));
    expect(entryLine).toMatch(/^\[.+T.+Z\] timestamped$/);
  });

  it("appends multiple entries", () => {
    const logger = new FileLogger(logPath);

    logger.debug("line1");
    logger.debug("line2");

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("line1");
    expect(content).toContain("line2");
    // Session header + 2 entries
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("creates file if it does not exist", () => {
    expect(fs.existsSync(logPath)).toBe(false);

    const logger = new FileLogger(logPath);
    logger.debug("create");

    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("writes session header as first line", () => {
    void new FileLogger(logPath);

    const content = fs.readFileSync(logPath, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toContain("=== Session started ===");
    expect(firstLine).toContain(logPath);
  });

  it("exposes the resolved file path", () => {
    const logger = new FileLogger(logPath);

    expect(logger.getFilePath()).toBe(logPath);
  });

  describe("append behavior", () => {
    it("appends to existing log instead of replacing it", () => {
      fs.writeFileSync(logPath, "old session data\n");

      void new FileLogger(logPath);

      const content = fs.readFileSync(logPath, "utf-8");
      // Old data preserved, session header appended
      expect(content).toContain("old session data");
      expect(content).toContain("=== Session started ===");
    });

    it("multiple sessions accumulate in one file", () => {
      const logger1 = new FileLogger(logPath);
      logger1.debug("session 1 work");

      const logger2 = new FileLogger(logPath);
      logger2.debug("session 2 work");

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("session 1 work");
      expect(content).toContain("session 2 work");

      // Two session headers
      const sessionHeaders = content.split("\n").filter(l => l.includes("=== Session started ==="));
      expect(sessionHeaders).toHaveLength(2);
    });

    it("no rotated files when under size limit", () => {
      fs.writeFileSync(logPath, "small data\n");

      void new FileLogger(logPath);

      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(0);
    });
  });

  describe("size-based rotation", () => {
    it("rotates when file exceeds size threshold", () => {
      // Write data exceeding the threshold
      fs.writeFileSync(logPath, "x".repeat(200));

      // Use a small threshold so it triggers
      void new FileLogger(logPath, 100);

      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(1);
      expect(rotated[0]).toMatch(/^debug\.\d{4}-\d{2}-\d{2}T.+\.log$/);

      // Rotated file has old data
      const rotatedContent = fs.readFileSync(path.join(tmpDir, rotated[0]), "utf-8");
      expect(rotatedContent).toBe("x".repeat(200));

      // New debug.log starts fresh with session header
      const newContent = fs.readFileSync(logPath, "utf-8");
      expect(newContent).toContain("=== Session started ===");
      expect(newContent).not.toContain("xxx");
    });

    it("does not rotate when file is under threshold", () => {
      fs.writeFileSync(logPath, "small\n");

      void new FileLogger(logPath, 1000);

      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(0);

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("small");
      expect(content).toContain("=== Session started ===");
    });
  });

  describe("log level", () => {
    it('suppresses verbose() entries at default "info" level', () => {
      const logger = new FileLogger(logPath);

      logger.verbose("sensitive payload data");

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).not.toContain("sensitive payload data");
    });

    it('writes verbose() entries when logLevel is "debug"', () => {
      const logger = new FileLogger(logPath, undefined, "debug");

      logger.verbose("full envelope payload");

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("full envelope payload");
    });

    it('always writes debug() entries regardless of logLevel', () => {
      const logger = new FileLogger(logPath, undefined, "info");

      logger.debug("operational event");

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("operational event");
    });

    it('writes both debug() and verbose() entries at "debug" level', () => {
      const logger = new FileLogger(logPath, undefined, "debug");

      logger.debug("envelope id=abc sender=alice");
      logger.verbose("payload={secret:true}");

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("envelope id=abc sender=alice");
      expect(content).toContain("payload={secret:true}");
    });
  });
});
