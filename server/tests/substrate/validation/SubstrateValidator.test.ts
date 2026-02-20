import { SubstrateValidator } from "../../../src/substrate/validation/SubstrateValidator";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

const DATA_DIR = "/substrate";

async function setupFs(
  fs: InMemoryFileSystem,
  files: Record<string, string>,
  mtimesMs?: Record<string, number>
): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const dir = relPath.includes("/") ? `${DATA_DIR}/${relPath.substring(0, relPath.lastIndexOf("/"))}` : DATA_DIR;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${DATA_DIR}/${relPath}`, content);
  }
  // Patch mtimes if provided (InMemoryFileSystem uses Date.now() internally)
  // We access the private files map via type assertion for test control
  if (mtimesMs) {
    const internal = fs as unknown as { files: Map<string, { content: string; mtimeMs: number }> };
    for (const [relPath, mtime] of Object.entries(mtimesMs)) {
      const fullPath = `${DATA_DIR}/${relPath}`;
      const entry = internal.files.get(fullPath);
      if (entry) {
        entry.mtimeMs = mtime;
      }
    }
  }
}

describe("SubstrateValidator", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let validator: SubstrateValidator;

  const NOW = new Date("2026-02-20T00:00:00Z");

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(NOW);
    validator = new SubstrateValidator(fs, DATA_DIR, clock);
  });

  describe("broken references", () => {
    it("reports no broken references when all refs exist", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n\n@memory/foo.md\n",
        "memory/foo.md": "# Foo\n\ncontent",
      });

      const report = await validator.validate();
      expect(report.brokenReferences).toHaveLength(0);
    });

    it("reports broken reference when target file does not exist", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n\n@memory/missing.md\n",
      });

      const report = await validator.validate();
      expect(report.brokenReferences).toHaveLength(1);
      expect(report.brokenReferences[0]).toEqual({
        file: "MEMORY.md",
        reference: "memory/missing.md",
      });
    });

    it("reports broken references from multiple index files", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n\n@memory/missing.md\n",
        "SKILLS.md": "# Skills\n\n@skills/gone.md\n",
      });

      const report = await validator.validate();
      expect(report.brokenReferences).toHaveLength(2);
    });

    it("skips index files that do not exist", async () => {
      // No index files at all
      const report = await validator.validate();
      expect(report.brokenReferences).toHaveLength(0);
    });
  });

  describe("orphaned files", () => {
    it("reports no orphans when all subdir files are referenced", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n\n@memory/foo.md\n",
        "memory/foo.md": "# Foo\n\ncontent",
      });

      const report = await validator.validate();
      expect(report.orphanedFiles).toHaveLength(0);
    });

    it("reports orphaned file that exists but is not referenced", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n\n@memory/referenced.md\n",
        "memory/referenced.md": "# Referenced",
        "memory/orphan.md": "# Orphan",
      });

      const report = await validator.validate();
      expect(report.orphanedFiles).toContain("memory/orphan.md");
      expect(report.orphanedFiles).not.toContain("memory/referenced.md");
    });

    it("reports orphans across multiple subdirectories", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n",
        "SKILLS.md": "# Skills\n",
        "memory/orphan.md": "# Orphan memory",
        "skills/orphan.md": "# Orphan skill",
      });

      const report = await validator.validate();
      expect(report.orphanedFiles).toContain("memory/orphan.md");
      expect(report.orphanedFiles).toContain("skills/orphan.md");
    });

    it("skips non-.md files in subdirectories", async () => {
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n",
        "memory/notes.txt": "not a markdown file",
      });

      const report = await validator.validate();
      expect(report.orphanedFiles).toHaveLength(0);
    });

    it("skips missing subdirectories gracefully", async () => {
      // No subdirs at all
      await setupFs(fs, {
        "MEMORY.md": "# Memory\n",
      });

      const report = await validator.validate();
      expect(report.orphanedFiles).toHaveLength(0);
    });
  });

  describe("stale files", () => {
    it("does not flag recently modified files", async () => {
      const recentMtime = NOW.getTime() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      await setupFs(
        fs,
        {
          "MEMORY.md": "# Memory\n\n@memory/recent.md\n",
          "memory/recent.md": "# Recent",
        },
        { "memory/recent.md": recentMtime }
      );

      const report = await validator.validate();
      expect(report.staleFiles).toHaveLength(0);
    });

    it("flags files unchanged for more than 30 days", async () => {
      const staleMtime = NOW.getTime() - 45 * 24 * 60 * 60 * 1000; // 45 days ago
      await setupFs(
        fs,
        {
          "MEMORY.md": "# Memory\n\n@memory/stale.md\n",
          "memory/stale.md": "# Stale",
        },
        { "memory/stale.md": staleMtime }
      );

      const report = await validator.validate();
      expect(report.staleFiles).toHaveLength(1);
      expect(report.staleFiles[0].file).toBe("memory/stale.md");
      expect(report.staleFiles[0].daysSinceUpdate).toBe(45);
    });

    it("only flags referenced files (not orphans) for staleness", async () => {
      const staleMtime = NOW.getTime() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
      await setupFs(
        fs,
        {
          "MEMORY.md": "# Memory\n",
          "memory/orphan.md": "# Orphan",
        },
        { "memory/orphan.md": staleMtime }
      );

      const report = await validator.validate();
      // Orphan is not referenced so not checked for staleness
      expect(report.staleFiles).toHaveLength(0);
      // But it IS reported as orphaned
      expect(report.orphanedFiles).toContain("memory/orphan.md");
    });
  });

  describe("report metadata", () => {
    it("includes timestamp from clock", async () => {
      const report = await validator.validate();
      expect(report.timestamp).toBe(NOW.toISOString());
    });

    it("always includes all required report fields", async () => {
      const report = await validator.validate();
      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("brokenReferences");
      expect(report).toHaveProperty("orphanedFiles");
      expect(report).toHaveProperty("staleFiles");
      expect(report).toHaveProperty("consolidationCandidates");
    });
  });
});
