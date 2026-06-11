/**
 * CycleLogWriter rotation unit tests (task-22).
 *
 * Verifies that the size-based rotation and archive pruning logic works correctly
 * without affecting the existing write behavior.
 */
import { CycleLogWriter } from "../../../src/substrate/io/CycleLogWriter";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

const SUBSTRATE = "/substrate";

async function makeWriter(options?: { maxSizeBytes?: number; keepFiles?: number }) {
  const fs = new InMemoryFileSystem();
  await fs.mkdir(SUBSTRATE, { recursive: true });
  const clock = new FixedClock(new Date("2026-06-11T09:21:37.000Z"));
  const writer = new CycleLogWriter(fs, clock, SUBSTRATE, "cycle_log.md", options);
  return { fs, clock, writer };
}

describe("CycleLogWriter — rotation", () => {
  it("does not rotate when file is below size cap", async () => {
    const { fs, writer } = await makeWriter({ maxSizeBytes: 1024 });

    await writer.write("EGO", "Short entry");

    // cycle_log.md must exist and no archives created
    const files = await fs.readdir(SUBSTRATE);
    const archives = files.filter(f => f !== "cycle_log.md" && f.startsWith("cycle_log."));
    expect(archives).toHaveLength(0);

    const content = await fs.readFile(`${SUBSTRATE}/cycle_log.md`);
    expect(content).toContain("[EGO] Short entry");
  });

  it("rotates active log to timestamped archive when size cap is reached", async () => {
    const { fs, writer } = await makeWriter({ maxSizeBytes: 50 });

    // Pre-seed the log with content that fills it close to the cap
    await fs.appendFile(`${SUBSTRATE}/cycle_log.md`, "x".repeat(40));

    // This write will push it over 50 bytes → triggers rotation before append
    await writer.write("EGO", "Overflow");

    const files = await fs.readdir(SUBSTRATE);
    const archives = files.filter(f => f !== "cycle_log.md" && f.startsWith("cycle_log."));
    expect(archives).toHaveLength(1);
    // Archive name should contain the ISO timestamp (with colons replaced by dashes)
    expect(archives[0]).toMatch(/cycle_log\.2026-06-11T09-21-37Z\.md/);

    // New active log should contain only the new entry (not the old content)
    const content = await fs.readFile(`${SUBSTRATE}/cycle_log.md`);
    expect(content).toContain("[EGO] Overflow");
    expect(content).not.toContain("x".repeat(40));

    // Archive should contain the old content
    const archived = await fs.readFile(`${SUBSTRATE}/${archives[0]}`);
    expect(archived).toContain("x".repeat(40));
  });

  it("does not rotate when file does not exist yet", async () => {
    const { fs, writer } = await makeWriter({ maxSizeBytes: 10 });

    // Write to a non-existent log — should not throw
    await writer.write("EGO", "First entry");

    const content = await fs.readFile(`${SUBSTRATE}/cycle_log.md`);
    expect(content).toContain("[EGO] First entry");

    const files = await fs.readdir(SUBSTRATE);
    const archives = files.filter(f => f !== "cycle_log.md" && f.startsWith("cycle_log."));
    expect(archives).toHaveLength(0);
  });

  it("prunes oldest archives when keepFiles limit is exceeded", async () => {
    const { fs, writer } = await makeWriter({ maxSizeBytes: 10, keepFiles: 2 });

    // Create 3 pre-existing archives
    await fs.writeFile(`${SUBSTRATE}/cycle_log.2026-01-01T00-00-01Z.md`, "old1");
    await fs.writeFile(`${SUBSTRATE}/cycle_log.2026-01-01T00-00-02Z.md`, "old2");
    await fs.writeFile(`${SUBSTRATE}/cycle_log.2026-01-01T00-00-03Z.md`, "old3");

    // Pre-seed active log beyond the cap so next write triggers rotation
    await fs.appendFile(`${SUBSTRATE}/cycle_log.md`, "x".repeat(20));

    // This write triggers rotation → new archive is created → total = 4 archives → prune to 2
    await writer.write("EGO", "Trigger rotation");

    const files = await fs.readdir(SUBSTRATE);
    const archives = files
      .filter(f => f !== "cycle_log.md" && f.startsWith("cycle_log."))
      .sort();

    // Should keep only 2 archives (the 2 newest)
    expect(archives).toHaveLength(2);
    // The oldest archive (old1) should have been deleted
    expect(archives).not.toContain("cycle_log.2026-01-01T00-00-01Z.md");
    // The newest archive (old3 + the just-created one) should remain
    expect(archives).toContain("cycle_log.2026-01-01T00-00-03Z.md");
  });

  it("uses default 10MB cap when no options are provided", async () => {
    const { fs, writer } = await makeWriter(); // no options

    // A small write should not trigger rotation
    await writer.write("EGO", "Small entry");

    const files = await fs.readdir(SUBSTRATE);
    const archives = files.filter(f => f !== "cycle_log.md" && f.startsWith("cycle_log."));
    expect(archives).toHaveLength(0);
  });

  it("new entry is written to fresh log after rotation", async () => {
    const { fs, writer } = await makeWriter({ maxSizeBytes: 5 });

    await fs.appendFile(`${SUBSTRATE}/cycle_log.md`, "full!");

    await writer.write("SUBCONSCIOUS", "After rotation");

    const content = await fs.readFile(`${SUBSTRATE}/cycle_log.md`);
    expect(content).toContain("[SUBCONSCIOUS] After rotation");
    expect(content).not.toContain("full!");
  });
});
