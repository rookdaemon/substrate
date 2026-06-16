import { EgoSessionCache } from "../../src/agents/EgoSessionCache";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { IClock } from "../../src/substrate/abstractions/IClock";

const SUBSTRATE_PATH = "/substrate";

function makeClock(nowDate: Date): IClock {
  return { now: () => nowDate };
}

async function makeFilesWithMtimes(
  fs: InMemoryFileSystem,
  planMtime: Date,
  ocMtime: Date,
): Promise<void> {
  await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
  await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
  await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# Operating Context");
  // InMemoryFileSystem uses current mtime on write — we patch it via touchFile if needed.
  // For tests where we need controlled mtimes, we use the patch mechanism.
  // The InMemoryFileSystem stat() returns the mtime at write time (Date.now()).
  // We set specific mtimes by using a clock-controlled variant.
  void planMtime; // suppress unused lint — used only in mtime-controlled tests below
  void ocMtime;
}

describe("EgoSessionCache", () => {
  describe("read() — cache absent", () => {
    it("returns null when cache file does not exist", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      const clock = makeClock(new Date("2026-06-16T10:00:00Z"));
      const cache = new EgoSessionCache(SUBSTRATE_PATH, fs, clock);
      const result = await cache.read();
      expect(result).toBeNull();
    });
  });

  describe("write() then read()", () => {
    it("returns notes when cache is fresh and fingerprint matches", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const writeTime = new Date("2026-06-16T10:00:00Z");
      const readTime = new Date("2026-06-16T10:30:00Z"); // 30 min later — within 4h

      const writeClock = makeClock(writeTime);
      const readClock = makeClock(readTime);

      const writeCache = new EgoSessionCache(SUBSTRATE_PATH, fs, writeClock);
      await writeCache.write("I was working on task X and didn't finish.", "action=dispatch");

      // Read using a fresh instance with a later clock
      const readCache = new EgoSessionCache(SUBSTRATE_PATH, fs, readClock);
      const result = await readCache.read();

      expect(result).not.toBeNull();
      expect(result!.notes).toContain("task X");
      expect(result!.priorSessionScope).toBe("action=dispatch");
    });

    it("overwrites on repeated write calls (no append)", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const now = new Date("2026-06-16T10:00:00Z");
      const clock = makeClock(now);
      const cache = new EgoSessionCache(SUBSTRATE_PATH, fs, clock);

      await cache.write("First session notes.", "first");
      await cache.write("Second session notes.", "second");

      // Need to read back after two writes — but read() renames to .prev.
      // Read directly from the file.
      const content = await fs.readFile(`${SUBSTRATE_PATH}/ego_session_cache.md`);
      expect(content).not.toContain("First session notes.");
      expect(content).toContain("Second session notes.");
    });

    it("returns null when cache is stale (older than staleness threshold)", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const writeTime = new Date("2026-06-16T00:00:00Z");
      const readTime = new Date("2026-06-16T10:00:00Z"); // 10 hours later — exceeds 4h

      const writeCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(writeTime));
      await writeCache.write("Stale notes.", "action=idle");

      const readCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(readTime));
      const result = await readCache.read();
      expect(result).toBeNull();
    });

    it("returns null when PLAN.md has been modified since cache was written", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan v1");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const now = new Date("2026-06-16T10:00:00Z");
      const cache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      await cache.write("Notes from before plan changed.", "action=dispatch");

      // Simulate PLAN.md being modified (different mtime via new write)
      // InMemoryFileSystem updates mtime on writeFile
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan v2");

      // Read after modification — cache was renamed to .prev during read(),
      // but now we need a fresh cache file to read. Actually read() was not called yet.
      // The cache file was written, then PLAN.md changed. Now read() should detect mismatch.
      const laterNow = new Date("2026-06-16T10:05:00Z");
      const readCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(laterNow));
      const result = await readCache.read();
      expect(result).toBeNull();
    });
  });

  describe("fail-closed behavior", () => {
    it("after a failed session (no write), cache is absent and next read returns null", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const now = new Date("2026-06-16T10:00:00Z");
      const cache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));

      // Write a cache entry (simulates a prior successful session)
      await cache.write("Prior session notes.", "action=dispatch");

      // Simulate Ego starting a new session: read() renames main → .prev
      // but then the session "fails" — no write() is called.
      const readCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      const firstRead = await readCache.read(); // This renames to .prev
      expect(firstRead).not.toBeNull(); // First read succeeds (fresh, fingerprint matches)

      // Main file is now gone (renamed to .prev). A second read should return null.
      const secondReadCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      const secondRead = await secondReadCache.read();
      expect(secondRead).toBeNull(); // Correctly signals: continuity broken
    });

    it(".prev file is never injected by a subsequent read", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const now = new Date("2026-06-16T10:00:00Z");

      // Write a cache entry
      const writeCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      await writeCache.write("Notes that will become .prev.", "action=dispatch");

      // read() renames main → .prev (simulates a failed session that never wrote a new cache)
      const readCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      await readCache.read();

      // .prev exists, main does not. A fresh read should return null (not inject .prev).
      const prevExists = await fs.exists(`${SUBSTRATE_PATH}/ego_session_cache.prev`);
      const mainExists = await fs.exists(`${SUBSTRATE_PATH}/ego_session_cache.md`);
      expect(prevExists).toBe(true);
      expect(mainExists).toBe(false);

      const thirdReadCache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));
      const result = await thirdReadCache.read();
      expect(result).toBeNull(); // .prev is never injected
    });
  });

  describe("word cap enforcement", () => {
    it("truncates notes that exceed 500 words", async () => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(`${SUBSTRATE_PATH}/PLAN.md`, "# Plan");
      await fs.writeFile(`${SUBSTRATE_PATH}/OPERATING_CONTEXT.md`, "# OC");

      const now = new Date("2026-06-16T10:00:00Z");
      const cache = new EgoSessionCache(SUBSTRATE_PATH, fs, makeClock(now));

      // Generate 600-word notes
      const longNotes = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
      await cache.write(longNotes, "action=idle");

      const content = await fs.readFile(`${SUBSTRATE_PATH}/ego_session_cache.md`);
      expect(content).toContain("[truncated to 500-word limit]");
      // The content should not contain word500 onwards (word500 would be the 501st word)
      expect(content).not.toContain("word500 word501");
    });
  });
});
