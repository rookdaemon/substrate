import { insMaintenanceTrim } from "../../../src/loop/ins/maintenanceTrim";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../../src/logging";

describe("insMaintenanceTrim", () => {
  let fs: InMemoryFileSystem;
  let logger: InMemoryLogger;
  const conversationPath = "/substrate/CONVERSATION.md";
  const threshold = 80;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    logger = new InMemoryLogger();
    await fs.mkdir("/substrate", { recursive: true });
  });

  it("does nothing when line count is below threshold", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `[2026-03-01T12:00:00.000Z] Entry ${i}`);
    const original = "# Conversation\n\n" + lines.join("\n");
    await fs.writeFile(conversationPath, original);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const content = await fs.readFile(conversationPath);
    expect(content).toBe(original);
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("does nothing when line count equals threshold", async () => {
    const header = "# Conversation\n\n";
    // Construct content that is exactly at the threshold line count
    const entryLines = Array.from({ length: threshold - 3 }, (_, i) => `[2026-03-01T12:00:00.000Z] Entry ${i}`);
    // header has 3 lines ("# Conversation", "", ""), entries make up the rest
    const content = header + entryLines.join("\n");
    // Pad or trim so it's exactly at threshold
    const lines = content.split("\n");
    while (lines.length < threshold) lines.push("");
    const atThresholdContent = lines.slice(0, threshold).join("\n");
    await fs.writeFile(conversationPath, atThresholdContent);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const result = await fs.readFile(conversationPath);
    expect(result).toBe(atThresholdContent);
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("trims raw entries to floor(threshold * 0.75) when over threshold", async () => {
    const header = "# Conversation\n\n";
    const entryCount = 100;
    const entryLines = Array.from(
      { length: entryCount },
      (_, i) => `[2026-03-01T12:00:00.000Z] [EGO] Entry ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    const before = content.split("\n").length;
    expect(before).toBeGreaterThan(threshold);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const newContent = await fs.readFile(conversationPath);
    const after = newContent.split("\n").length;
    expect(after).toBe(Math.floor(threshold * 0.75));
  });

  it("preserves the structural head (headers and non-entry content)", async () => {
    const structuralHead = [
      "# Conversation",
      "",
      "## Summary of Earlier Conversation",
      "",
      "Earlier discussion summary here.",
      "",
      "## Recent Conversation (Last Hour)",
      "",
    ].join("\n");

    const entryLines = Array.from(
      { length: 90 },
      (_, i) => `[2026-03-01T12:00:00.000Z] [SUBCONSCIOUS] Entry ${i}`,
    );
    const content = structuralHead + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const newContent = await fs.readFile(conversationPath);
    expect(newContent.startsWith(structuralHead)).toBe(true);
    expect(newContent).toContain("## Summary of Earlier Conversation");
    expect(newContent).toContain("Earlier discussion summary here.");
    expect(newContent).toContain("## Recent Conversation (Last Hour)");
  });

  it("removes oldest entries first (preserves most recent)", async () => {
    const header = "# Conversation\n\n";
    const entryLines = Array.from(
      { length: 90 },
      (_, i) => `[2026-03-01T12:00:${String(i).padStart(2, "0")}.000Z] Entry ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const newContent = await fs.readFile(conversationPath);
    // Most recent entries should be preserved
    expect(newContent).toContain("Entry 89");
    expect(newContent).toContain("Entry 88");
    // Oldest entries should be trimmed
    expect(newContent).not.toContain("Entry 0");
    expect(newContent).not.toContain("Entry 1");
  });

  it("logs before and after line counts", async () => {
    const header = "# Conversation\n\n";
    const entryLines = Array.from(
      { length: 90 },
      (_, i) => `[2026-03-01T12:00:00.000Z] Entry ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    const before = content.split("\n").length;
    const after = Math.floor(threshold * 0.75);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    expect(logger.getEntries().some((m) => m.includes(`[INS] Rate-limit trim: ${before} → ${after} lines`))).toBeTruthy();
  });

  it("does nothing when file does not exist", async () => {
    await expect(
      insMaintenanceTrim("/substrate/MISSING.md", threshold, fs, logger),
    ).resolves.not.toThrow();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("does nothing when file has no raw entries (no lines starting with '[')", async () => {
    const structuralOnly = "# Conversation\n\nSome structural content only.\n\nNo entries here.\n";
    // Pad to exceed threshold without any '[' entries
    const padded = structuralOnly + Array.from({ length: 100 }, (_, i) => `Structural line ${i}`).join("\n");
    await fs.writeFile(conversationPath, padded);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    // No trim logged (since there are no raw entries to trim)
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("trims [UNPROCESSED] entries like other raw entries", async () => {
    const header = "# Conversation\n\n";
    const entryLines = Array.from(
      { length: 90 },
      (_, i) =>
        i % 3 === 0
          ? `[2026-03-01T12:00:00.000Z] **FROM:** peer **TO:** me publish: **[UNPROCESSED]** message ${i}`
          : `[2026-03-01T12:00:00.000Z] [EGO] Reply ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const newContent = await fs.readFile(conversationPath);
    const after = newContent.split("\n").length;
    expect(after).toBe(Math.floor(threshold * 0.75));
  });

  it("does not trim beyond available raw entries (structural head is always preserved)", async () => {
    const header = "# Conversation\n\n";
    // Very few raw entries — far fewer than would be needed to reach target
    const entryLines = Array.from(
      { length: 5 },
      (_, i) => `[2026-03-01T12:00:00.000Z] Entry ${i}`,
    );
    // Pad the structural head with many non-entry lines to force over threshold
    const structuralContent = Array.from({ length: 90 }, (_, i) => `Structural line ${i}`).join("\n");
    const content = header + structuralContent + "\n" + entryLines.join("\n");
    await fs.writeFile(conversationPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const newContent = await fs.readFile(conversationPath);
    // Structural head must still be intact
    expect(newContent).toContain("Structural line 0");
    expect(newContent).toContain("Structural line 89");
  });
});

describe("insMaintenanceTrim — PROGRESS.md", () => {
  let fs: InMemoryFileSystem;
  let logger: InMemoryLogger;
  const conversationPath = "/substrate/CONVERSATION.md";
  const progressPath = "/substrate/PROGRESS.md";
  const threshold = 200;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    logger = new InMemoryLogger();
    await fs.mkdir("/substrate", { recursive: true });
    // CONVERSATION.md well under threshold so it never triggers
    await fs.writeFile(conversationPath, "# Conversation\n\n[2026-01-01T00:00:00.000Z] Entry\n");
  });

  it("does nothing when PROGRESS.md is below threshold", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[2026-03-01T12:00:00.000Z] Progress ${i}`);
    const original = "# Progress\n\n" + lines.join("\n");
    await fs.writeFile(progressPath, original);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger, progressPath);

    const content = await fs.readFile(progressPath);
    expect(content).toBe(original);
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("trims PROGRESS.md to floor(threshold * 0.85) when over threshold", async () => {
    const header = "# Progress\n\n";
    const entryLines = Array.from(
      { length: 250 },
      (_, i) => `[2026-03-01T12:00:00.000Z] Progress entry ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(progressPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger, progressPath);

    const newContent = await fs.readFile(progressPath);
    const after = newContent.split("\n").length;
    expect(after).toBe(Math.floor(threshold * 0.85));
  });

  it("preserves structural head in PROGRESS.md", async () => {
    const structuralHead = [
      "# Progress",
      "",
      "## Goals",
      "",
      "Key objectives here.",
      "",
    ].join("\n");

    const entryLines = Array.from(
      { length: 250 },
      (_, i) => `[2026-03-01T12:00:00.000Z] Progress entry ${i}`,
    );
    const content = structuralHead + entryLines.join("\n");
    await fs.writeFile(progressPath, content);

    await insMaintenanceTrim(conversationPath, threshold, fs, logger, progressPath);

    const newContent = await fs.readFile(progressPath);
    expect(newContent.startsWith(structuralHead)).toBe(true);
    expect(newContent).toContain("## Goals");
    expect(newContent).toContain("Key objectives here.");
  });

  it("does not trim PROGRESS.md when progressPath is not provided", async () => {
    const header = "# Progress\n\n";
    const entryLines = Array.from(
      { length: 250 },
      (_, i) => `[2026-03-01T12:00:00.000Z] Progress entry ${i}`,
    );
    const content = header + entryLines.join("\n");
    await fs.writeFile(progressPath, content);

    // Call without progressPath
    await insMaintenanceTrim(conversationPath, threshold, fs, logger);

    const unchanged = await fs.readFile(progressPath);
    expect(unchanged).toBe(content);
  });

  it("PROGRESS.md uses 0.85 ratio while CONVERSATION.md uses 0.75", async () => {
    // Both files over threshold
    const convLines = Array.from({ length: 250 }, (_, i) => `[2026-03-01T12:00:00.000Z] Conv ${i}`);
    await fs.writeFile(conversationPath, "# Conversation\n\n" + convLines.join("\n"));

    const progLines = Array.from({ length: 250 }, (_, i) => `[2026-03-01T12:00:00.000Z] Prog ${i}`);
    await fs.writeFile(progressPath, "# Progress\n\n" + progLines.join("\n"));

    await insMaintenanceTrim(conversationPath, threshold, fs, logger, progressPath);

    const convContent = await fs.readFile(conversationPath);
    const progContent = await fs.readFile(progressPath);

    expect(convContent.split("\n").length).toBe(Math.floor(threshold * 0.75));
    expect(progContent.split("\n").length).toBe(Math.floor(threshold * 0.85));
  });
});
