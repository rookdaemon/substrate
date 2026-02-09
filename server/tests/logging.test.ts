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
    // First line is the session header, second line is the entry
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

  it("writes session header with log path as first line", () => {
    void new FileLogger(logPath);

    const content = fs.readFileSync(logPath, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toContain("Session started");
    expect(firstLine).toContain(logPath);
  });

  it("exposes the resolved file path", () => {
    const logger = new FileLogger(logPath);

    expect(logger.getFilePath()).toBe(logPath);
  });

  describe("log rotation", () => {
    it("rotates existing log file on construction", () => {
      // Write a "previous session" log
      fs.writeFileSync(logPath, "old session data\n");

      // Creating a new FileLogger should rotate the old file
      void new FileLogger(logPath);

      // Old file should be renamed — check that a rotated file exists
      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(1);
      expect(rotated[0]).toMatch(/^debug\.\d{4}-\d{2}-\d{2}T.+\.log$/);

      // Rotated file should contain old data
      const rotatedContent = fs.readFileSync(path.join(tmpDir, rotated[0]), "utf-8");
      expect(rotatedContent).toBe("old session data\n");

      // New debug.log should have fresh session header
      const newContent = fs.readFileSync(logPath, "utf-8");
      expect(newContent).toContain("Session started");
      expect(newContent).not.toContain("old session data");
    });

    it("does not rotate when no previous log exists", () => {
      void new FileLogger(logPath);

      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(0);
    });

    it("preserves multiple rotated files across sessions", () => {
      // Session 1
      fs.writeFileSync(logPath, "session 1\n");

      // Session 2 — rotates session 1
      void new FileLogger(logPath);
      // Manually write some content and close by writing directly
      fs.writeFileSync(logPath, "session 2\n");

      // Wait 1ms so timestamp differs
      const start = Date.now();
      while (Date.now() - start < 2) { /* busy wait */ }

      // Session 3 — rotates session 2
      void new FileLogger(logPath);

      const files = fs.readdirSync(tmpDir);
      const rotated = files.filter(f => f.startsWith("debug.") && f !== "debug.log");
      expect(rotated).toHaveLength(2);
    });
  });
});
