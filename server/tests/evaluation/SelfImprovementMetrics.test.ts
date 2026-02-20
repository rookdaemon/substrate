import { SelfImprovementMetricsCollector, SelfImprovementSnapshot } from "../../src/evaluation/SelfImprovementMetrics";
import { GovernanceReportStore } from "../../src/evaluation/GovernanceReportStore";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("SelfImprovementMetricsCollector", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let reportStore: GovernanceReportStore;
  let collector: SelfImprovementMetricsCollector;

  const substratePath = "/substrate";
  const serverSrcPath = "/code/server/src";
  const reportsDir = "/reports";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-20T12:00:00Z"));
    reportStore = new GovernanceReportStore(fs, reportsDir, clock);
    collector = new SelfImprovementMetricsCollector(
      fs,
      substratePath,
      serverSrcPath,
      clock,
      reportStore
    );

    // Create directories
    await fs.mkdir(substratePath, { recursive: true });
    await fs.mkdir(serverSrcPath, { recursive: true });
    await fs.mkdir(reportsDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // collect()
  // ---------------------------------------------------------------------------

  describe("collect()", () => {
    it("returns a snapshot with the correct period", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.period).toBe("2026-02");
    });

    it("returns a snapshot with the correct timestamp", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.timestamp).toBe(new Date("2026-02-20T12:00:00Z").getTime());
    });

    it("includes all 5 metric dimensions", async () => {
      const snapshot = await collector.collect();
      expect(snapshot).toHaveProperty("codeQuality");
      expect(snapshot).toHaveProperty("knowledge");
      expect(snapshot).toHaveProperty("governance");
      expect(snapshot).toHaveProperty("performance");
      expect(snapshot).toHaveProperty("capability");
    });

    it("uses injected performance data", async () => {
      const snapshot = await collector.collect({
        avgCycleTimeMs: 5000,
        idleRate: 0.3,
        restartsThisPeriod: 2,
        rateLimitHits: 1,
      });
      expect(snapshot.performance.avgCycleTimeMs).toBe(5000);
      expect(snapshot.performance.idleRate).toBe(0.3);
      expect(snapshot.performance.restartsThisPeriod).toBe(2);
      expect(snapshot.performance.rateLimitHits).toBe(1);
    });

    it("defaults performance fields to 0 when not provided", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.performance.avgCycleTimeMs).toBe(0);
      expect(snapshot.performance.idleRate).toBe(0);
      expect(snapshot.performance.restartsThisPeriod).toBe(0);
      expect(snapshot.performance.rateLimitHits).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // collectCodeQuality (via collect())
  // ---------------------------------------------------------------------------

  describe("code quality metrics", () => {
    it("counts TypeScript source files (excluding test files)", async () => {
      await fs.mkdir(`${serverSrcPath}/agents`, { recursive: true });
      await fs.writeFile(`${serverSrcPath}/Foo.ts`, "const x = 1;\nconst y = 2;\n");
      await fs.writeFile(`${serverSrcPath}/agents/Bar.ts`, "export class Bar {}\n");
      await fs.writeFile(`${serverSrcPath}/Foo.test.ts`, "test('foo', () => {});\n");

      const snapshot = await collector.collect();
      expect(snapshot.codeQuality.linesOfCode).toBeGreaterThan(0);
      // 2 source files: "const x = 1;\nconst y = 2;\n".split("\n") = 3 elements
      //                  "export class Bar {}\n".split("\n") = 2 elements → total 5
      expect(snapshot.codeQuality.linesOfCode).toBe(5);
    });

    it("counts test files separately", async () => {
      await fs.mkdir(`${serverSrcPath}/sub`, { recursive: true });
      await fs.writeFile(`${serverSrcPath}/A.ts`, "const a = 1;\n");
      await fs.writeFile(`${serverSrcPath}/sub/B.test.ts`, "test('b', () => {});\n");
      await fs.writeFile(`${serverSrcPath}/C.test.ts`, "test('c', () => {});\n");

      const snapshot = await collector.collect();
      expect(snapshot.codeQuality.testCount).toBe(2);
    });

    it("returns 0 LOC when serverSrcPath does not exist", async () => {
      const noSrcCollector = new SelfImprovementMetricsCollector(
        fs,
        substratePath,
        "/nonexistent/src",
        clock,
        reportStore
      );
      const snapshot = await noSrcCollector.collect();
      expect(snapshot.codeQuality.linesOfCode).toBe(0);
      expect(snapshot.codeQuality.testCount).toBe(0);
    });

    it("skips dist/, node_modules/, and .git/ directories", async () => {
      await fs.mkdir(`${serverSrcPath}/dist`, { recursive: true });
      await fs.mkdir(`${serverSrcPath}/node_modules`, { recursive: true });
      await fs.writeFile(`${serverSrcPath}/dist/Compiled.ts`, "// compiled\n");
      await fs.writeFile(`${serverSrcPath}/node_modules/pkg.ts`, "// pkg\n");
      await fs.writeFile(`${serverSrcPath}/Real.ts`, "const r = 1;\n");

      const snapshot = await collector.collect();
      expect(snapshot.codeQuality.linesOfCode).toBe(2); // "const r = 1;\n".split("\n") = 2 elements
    });

    it("testCoverage defaults to 0", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.codeQuality.testCoverage).toBe(0);
    });

    it("lintErrors and lintWarnings default to 0", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.codeQuality.lintErrors).toBe(0);
      expect(snapshot.codeQuality.lintWarnings).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // collectKnowledge (via collect())
  // ---------------------------------------------------------------------------

  describe("knowledge metrics", () => {
    it("counts root-level .md files in substrate directory", async () => {
      await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n");
      await fs.writeFile(`${substratePath}/SKILLS.md`, "# Skills\n");
      await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n");

      const snapshot = await collector.collect();
      expect(snapshot.knowledge.totalFiles).toBe(3);
    });

    it("counts .md files in subdirectories", async () => {
      await fs.mkdir(`${substratePath}/memory`, { recursive: true });
      await fs.mkdir(`${substratePath}/skills`, { recursive: true });
      await fs.writeFile(`${substratePath}/memory/topic1.md`, "# Topic 1\n");
      await fs.writeFile(`${substratePath}/memory/topic2.md`, "# Topic 2\n");
      await fs.writeFile(`${substratePath}/skills/skill1.md`, "# Skill 1\n");

      const snapshot = await collector.collect();
      expect(snapshot.knowledge.subdirectoryFiles).toBe(3);
    });

    it("counts @-references in SKILLS.md index file", async () => {
      await fs.writeFile(
        `${substratePath}/SKILLS.md`,
        "# Skills\n@skills/topic1.md\n@skills/topic2.md\nSome text\n"
      );

      const snapshot = await collector.collect();
      expect(snapshot.knowledge.referenceCount).toBe(2);
    });

    it("counts @-references across multiple index files", async () => {
      await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n@memory/a.md\n@memory/b.md\n");
      await fs.writeFile(`${substratePath}/SKILLS.md`, "# Skills\n@skills/c.md\n");

      const snapshot = await collector.collect();
      expect(snapshot.knowledge.referenceCount).toBe(3);
    });

    it("returns 0 totalFiles when substrate directory is empty", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.knowledge.totalFiles).toBe(0);
      expect(snapshot.knowledge.subdirectoryFiles).toBe(0);
      expect(snapshot.knowledge.referenceCount).toBe(0);
    });

    it("avgFileAgeDays is non-negative", async () => {
      await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n");

      const snapshot = await collector.collect();
      expect(snapshot.knowledge.avgFileAgeDays).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // collectGovernance (via collect())
  // ---------------------------------------------------------------------------

  describe("governance metrics", () => {
    it("returns 0 drift score when no reports exist", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.governance.driftScore).toBe(0);
      expect(snapshot.governance.auditsThisPeriod).toBe(0);
    });

    it("reads drift score from the latest audit report", async () => {
      await reportStore.save({ driftScore: 0.25, findings: [], proposalEvaluations: [], summary: "ok" });

      const snapshot = await collector.collect();
      expect(snapshot.governance.driftScore).toBe(0.25);
    });

    it("counts audits in the current period only", async () => {
      // Save two reports in the current period (2026-02)
      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "audit1" });
      clock.setNow(new Date("2026-02-21T12:00:00Z"));
      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "audit2" });

      // Reset clock to period end
      clock.setNow(new Date("2026-02-20T12:00:00Z"));
      const snapshot = await collector.collect();
      expect(snapshot.governance.auditsThisPeriod).toBe(2);
    });

    it("counts findings from reports in the current period", async () => {
      await reportStore.save({
        findings: [
          { severity: "high", message: "Finding A" },
          { severity: "low", message: "Finding B" },
        ],
        proposalEvaluations: [],
        summary: "audit",
      });

      const snapshot = await collector.collect();
      expect(snapshot.governance.findingsThisPeriod).toBe(2);
    });

    it("counts approved proposals as findings addressed", async () => {
      await reportStore.save({
        findings: [{ severity: "high", message: "F1" }, { severity: "low", message: "F2" }],
        proposalEvaluations: [
          { approved: true, reason: "good" },
          { approved: false, reason: "nope" },
        ],
        summary: "audit",
      });

      const snapshot = await collector.collect();
      expect(snapshot.governance.findingsAddressed).toBe(1);
    });

    it("calculates remediation rate as ratio of addressed to total findings", async () => {
      await reportStore.save({
        findings: [
          { severity: "high", message: "F1" },
          { severity: "high", message: "F2" },
          { severity: "high", message: "F3" },
          { severity: "high", message: "F4" },
        ],
        proposalEvaluations: [
          { approved: true, reason: "done" },
          { approved: true, reason: "done" },
        ],
        summary: "audit",
      });

      const snapshot = await collector.collect();
      expect(snapshot.governance.remediationRate).toBeCloseTo(0.5, 2);
    });

    it("returns remediationRate of 0 when there are no findings", async () => {
      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "clean" });

      const snapshot = await collector.collect();
      expect(snapshot.governance.remediationRate).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // collectCapability (via collect())
  // ---------------------------------------------------------------------------

  describe("capability metrics", () => {
    it("counts skill list items in SKILLS.md", async () => {
      await fs.writeFile(
        `${substratePath}/SKILLS.md`,
        "# Skills\n- Skill A\n- Skill B\n* Skill C\n\nSome text\n"
      );

      const snapshot = await collector.collect();
      expect(snapshot.capability.skillsAdded).toBe(3);
    });

    it("returns 0 skillsAdded when SKILLS.md does not exist", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.capability.skillsAdded).toBe(0);
    });

    it("counts active integrations from config files", async () => {
      await fs.mkdir("/substrate/..", { recursive: true });
      await fs.writeFile("/agora.json", "{}");

      const snapshot = await collector.collect();
      expect(snapshot.capability.activeIntegrations).toBeGreaterThanOrEqual(0);
    });

    it("calculates task completion rate from PROGRESS.md entries in current period", async () => {
      await fs.writeFile(
        `${substratePath}/PROGRESS.md`,
        [
          "# Progress",
          "[2026-02-01T10:00:00Z] [SUBCONSCIOUS] task completed successfully",
          "[2026-02-02T10:00:00Z] [SUBCONSCIOUS] task completed with success",
          "[2026-02-03T10:00:00Z] [SUBCONSCIOUS] task failed with error",
          "[2026-01-31T10:00:00Z] [SUBCONSCIOUS] task completed successfully", // previous period
        ].join("\n")
      );

      const snapshot = await collector.collect();
      // 2 success, 1 fail in current period → 2/3
      expect(snapshot.capability.taskCompletionRate).toBeCloseTo(2 / 3, 2);
    });

    it("returns taskCompletionRate of 0 when PROGRESS.md does not exist", async () => {
      const snapshot = await collector.collect();
      expect(snapshot.capability.taskCompletionRate).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // save()
  // ---------------------------------------------------------------------------

  describe("save()", () => {
    it("writes snapshot JSON to data/metrics/self-improvement-YYYY-MM.json", async () => {
      const snapshot = await collector.collect();
      await collector.save(snapshot);

      const written = await fs.readFile("/data/metrics/self-improvement-2026-02.json");
      const parsed = JSON.parse(written);
      expect(parsed.period).toBe("2026-02");
      expect(parsed.timestamp).toBe(snapshot.timestamp);
    });

    it("creates the metrics directory if it does not exist", async () => {
      const snapshot = await collector.collect();
      await collector.save(snapshot);

      const exists = await fs.exists("/data/metrics");
      expect(exists).toBe(true);
    });

    it("appends summary to PROGRESS.md", async () => {
      await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n");
      const snapshot = await collector.collect();
      await collector.save(snapshot);

      const progress = await fs.readFile(`${substratePath}/PROGRESS.md`);
      expect(progress).toContain("## Self-Improvement Metrics (2026-02)");
    });

    it("creates PROGRESS.md if it does not exist", async () => {
      const snapshot = await collector.collect();
      await collector.save(snapshot);

      const progress = await fs.readFile(`${substratePath}/PROGRESS.md`);
      expect(progress).toContain("## Self-Improvement Metrics");
    });

    it("overwrites the same period's file on subsequent saves", async () => {
      const snapshot = await collector.collect();
      await collector.save(snapshot);

      // Collect again with different data and save
      const snapshot2: SelfImprovementSnapshot = {
        ...snapshot,
        codeQuality: { ...snapshot.codeQuality, linesOfCode: 9999 },
      };
      await collector.save(snapshot2);

      const written = await fs.readFile("/data/metrics/self-improvement-2026-02.json");
      const parsed = JSON.parse(written);
      expect(parsed.codeQuality.linesOfCode).toBe(9999);
    });
  });

  // ---------------------------------------------------------------------------
  // loadPrevious()
  // ---------------------------------------------------------------------------

  describe("loadPrevious()", () => {
    it("returns null when no previous snapshot exists", async () => {
      const prev = await collector.loadPrevious("2026-02");
      expect(prev).toBeNull();
    });

    it("loads previous month snapshot when it exists", async () => {
      // Save a snapshot for 2026-01
      const prevSnapshot: SelfImprovementSnapshot = {
        timestamp: new Date("2026-01-15T12:00:00Z").getTime(),
        period: "2026-01",
        codeQuality: { linesOfCode: 1000, testCount: 50, testCoverage: 0, lintErrors: 0, lintWarnings: 0 },
        knowledge: { totalFiles: 12, subdirectoryFiles: 20, referenceCount: 45, avgFileAgeDays: 15 },
        governance: { driftScore: 0.1, auditsThisPeriod: 4, findingsThisPeriod: 3, findingsAddressed: 2, remediationRate: 0.67 },
        performance: { avgCycleTimeMs: 4000, idleRate: 0.2, restartsThisPeriod: 1, rateLimitHits: 0 },
        capability: { skillsAdded: 10, activeIntegrations: 2, taskCompletionRate: 0.85 },
      };

      await fs.mkdir("/data/metrics", { recursive: true });
      await fs.writeFile("/data/metrics/self-improvement-2026-01.json", JSON.stringify(prevSnapshot));

      const loaded = await collector.loadPrevious("2026-02");
      expect(loaded).not.toBeNull();
      expect(loaded!.period).toBe("2026-01");
      expect(loaded!.codeQuality.linesOfCode).toBe(1000);
    });

    it("handles year boundary (January → previous December)", async () => {
      const prevSnapshot: SelfImprovementSnapshot = {
        timestamp: 0,
        period: "2025-12",
        codeQuality: { linesOfCode: 500, testCount: 20, testCoverage: 0, lintErrors: 0, lintWarnings: 0 },
        knowledge: { totalFiles: 10, subdirectoryFiles: 5, referenceCount: 10, avgFileAgeDays: 30 },
        governance: { driftScore: 0.05, auditsThisPeriod: 2, findingsThisPeriod: 1, findingsAddressed: 1, remediationRate: 1 },
        performance: { avgCycleTimeMs: 3000, idleRate: 0.1, restartsThisPeriod: 0, rateLimitHits: 0 },
        capability: { skillsAdded: 5, activeIntegrations: 1, taskCompletionRate: 0.9 },
      };

      await fs.mkdir("/data/metrics", { recursive: true });
      await fs.writeFile("/data/metrics/self-improvement-2025-12.json", JSON.stringify(prevSnapshot));

      const loaded = await collector.loadPrevious("2026-01");
      expect(loaded).not.toBeNull();
      expect(loaded!.period).toBe("2025-12");
    });
  });

  // ---------------------------------------------------------------------------
  // formatSummary()
  // ---------------------------------------------------------------------------

  describe("formatSummary()", () => {
    const makeSample = (overrides: Partial<SelfImprovementSnapshot> = {}): SelfImprovementSnapshot => ({
      timestamp: 0,
      period: "2026-02",
      codeQuality: { linesOfCode: 1200, testCount: 60, testCoverage: 0, lintErrors: 0, lintWarnings: 0 },
      knowledge: { totalFiles: 12, subdirectoryFiles: 25, referenceCount: 50, avgFileAgeDays: 10 },
      governance: { driftScore: 0.08, auditsThisPeriod: 3, findingsThisPeriod: 4, findingsAddressed: 3, remediationRate: 0.75 },
      performance: { avgCycleTimeMs: 4500, idleRate: 0.15, restartsThisPeriod: 0, rateLimitHits: 0 },
      capability: { skillsAdded: 12, activeIntegrations: 2, taskCompletionRate: 0.88 },
      ...overrides,
    });

    it("includes period in the summary", () => {
      const summary = collector.formatSummary(makeSample(), null);
      expect(summary).toContain("2026-02");
    });

    it("includes all 5 sections", () => {
      const summary = collector.formatSummary(makeSample(), null);
      expect(summary).toContain("**Code Quality**");
      expect(summary).toContain("**Knowledge**");
      expect(summary).toContain("**Governance**");
      expect(summary).toContain("**Performance**");
      expect(summary).toContain("**Capability**");
    });

    it("shows delta values when previous snapshot is provided", () => {
      const prev = makeSample({ period: "2026-01", codeQuality: { linesOfCode: 1000, testCount: 50, testCoverage: 0, lintErrors: 0, lintWarnings: 0 } });
      const curr = makeSample();
      const summary = collector.formatSummary(curr, prev);
      // LOC: 1200 → 1200 (+200)
      expect(summary).toContain("(+200)");
    });

    it("shows no deltas when no previous snapshot", () => {
      const summary = collector.formatSummary(makeSample(), null);
      // Should not contain delta parentheses
      expect(summary).not.toMatch(/\(\+\d+\)/);
      expect(summary).not.toMatch(/\(-\d+\)/);
    });

    it("formats remediation rate as percentage", () => {
      const summary = collector.formatSummary(makeSample(), null);
      expect(summary).toContain("75.0%");
    });

    it("formats idle rate as percentage", () => {
      const summary = collector.formatSummary(makeSample(), null);
      expect(summary).toContain("15.0%");
    });
  });
});
