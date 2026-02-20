import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import { GovernanceReportStore } from "./GovernanceReportStore";
import * as path from "node:path";

export interface CodeQualityMetrics {
  linesOfCode: number;
  testCount: number;
  testCoverage: number; // percentage (0-100); 0 when not computed
  lintErrors: number;   // 0 when not computed
  lintWarnings: number; // 0 when not computed
}

export interface KnowledgeMetrics {
  totalFiles: number;
  subdirectoryFiles: number;
  referenceCount: number;
  avgFileAgeDays: number;
}

export interface GovernanceMetrics {
  driftScore: number;
  auditsThisPeriod: number;
  findingsThisPeriod: number;
  findingsAddressed: number;
  remediationRate: number; // 0-1
}

export interface PerformanceMetrics {
  avgCycleTimeMs: number;
  idleRate: number;           // 0-1
  restartsThisPeriod: number;
  rateLimitHits: number;
}

export interface CapabilityMetrics {
  skillsAdded: number;
  activeIntegrations: number;
  taskCompletionRate: number; // 0-1
}

export interface SelfImprovementSnapshot {
  timestamp: number;
  period: string; // "YYYY-MM"
  codeQuality: CodeQualityMetrics;
  knowledge: KnowledgeMetrics;
  governance: GovernanceMetrics;
  performance: PerformanceMetrics;
  capability: CapabilityMetrics;
}

/** Injectable performance data — all fields optional, defaults to 0 */
export interface PerformanceInput {
  avgCycleTimeMs?: number;
  idleRate?: number;
  restartsThisPeriod?: number;
  rateLimitHits?: number;
}

// Index files that contain @-references to subdirectory detail files
const SUBSTRATE_INDEX_FILES = [
  "MEMORY.md", "HABITS.md", "SKILLS.md", "VALUES.md",
  "ID.md", "SECURITY.md", "SUPEREGO.md",
];

// Subdirectories that hold detail files referenced from index files
const SUBSTRATE_SUBDIRS = ["memory", "habits", "skills", "values", "id", "security", "superego"];

// Known integration config files to check for active integrations
const INTEGRATION_CONFIG_FILES = ["agora.json", "moltbook.json"];

// Directories to skip during recursive source file listing
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".metrics", "coverage"]);

/**
 * Collects quantitative self-improvement metrics across 5 dimensions.
 *
 * Designed for monthly collection. Metrics are persisted to
 * `{substratePath}/../data/metrics/self-improvement-YYYY-MM.json`
 * and a human-readable summary is appended to PROGRESS.md.
 *
 * All I/O is through IFileSystem to allow full in-memory testing.
 * External tool metrics (testCoverage, lintErrors) default to 0 because
 * they require running jest/eslint, which is not suitable for unit tests.
 */
export class SelfImprovementMetricsCollector {
  constructor(
    private readonly fs: IFileSystem,
    private readonly substratePath: string,
    private readonly serverSrcPath: string,
    private readonly clock: IClock,
    private readonly reportStore: GovernanceReportStore
  ) {}

  /**
   * Collect all 5 metric dimensions and return a snapshot.
   * @param perf Optional performance data from the running orchestrator.
   */
  async collect(perf: PerformanceInput = {}): Promise<SelfImprovementSnapshot> {
    const now = this.clock.now();
    const period = now.toISOString().slice(0, 7); // "YYYY-MM"

    return {
      timestamp: now.getTime(),
      period,
      codeQuality: await this.collectCodeQuality(),
      knowledge: await this.collectKnowledge(),
      governance: await this.collectGovernance(period),
      performance: this.buildPerformance(perf),
      capability: await this.collectCapability(period),
    };
  }

  /**
   * Persist a snapshot to disk and append a readable summary to PROGRESS.md.
   */
  async save(snapshot: SelfImprovementSnapshot): Promise<void> {
    const metricsDir = path.join(this.substratePath, "..", "data", "metrics");
    await this.fs.mkdir(metricsDir, { recursive: true });

    const filename = `self-improvement-${snapshot.period}.json`;
    await this.fs.writeFile(
      path.join(metricsDir, filename),
      JSON.stringify(snapshot, null, 2)
    );

    const previous = await this.loadPrevious(snapshot.period);
    const summary = this.formatSummary(snapshot, previous);
    await this.fs.appendFile(
      path.join(this.substratePath, "PROGRESS.md"),
      `\n## Self-Improvement Metrics (${snapshot.period})\n\n${summary}\n`
    );
  }

  /**
   * Load the snapshot from the previous month, if it exists.
   */
  async loadPrevious(currentPeriod: string): Promise<SelfImprovementSnapshot | null> {
    const [year, month] = currentPeriod.split("-").map(Number);
    const prevDate = new Date(year, month - 2); // period month is 1-indexed; Date month is 0-indexed; subtract 2 to go back one month
    const prevPeriod = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

    const metricsDir = path.join(this.substratePath, "..", "data", "metrics");
    try {
      const content = await this.fs.readFile(path.join(metricsDir, `self-improvement-${prevPeriod}.json`));
      return JSON.parse(content) as SelfImprovementSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Format a human-readable summary with optional deltas from the previous period.
   */
  formatSummary(current: SelfImprovementSnapshot, previous: SelfImprovementSnapshot | null): string {
    const delta = (curr: number, prev: number | undefined, decimals = 0, unit = ""): string => {
      const formatted = decimals > 0 ? curr.toFixed(decimals) : String(curr);
      if (prev === undefined) return `${formatted}${unit}`;
      const d = curr - prev;
      const sign = d > 0 ? "+" : "";
      const deltaFormatted = decimals > 0 ? d.toFixed(decimals) : String(Math.round(d));
      return `${formatted}${unit} (${sign}${deltaFormatted}${unit})`;
    };

    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

    const lines: string[] = [
      `**Period:** ${current.period}`,
      ``,
      `**Code Quality**`,
      `- Lines of code: ${delta(current.codeQuality.linesOfCode, previous?.codeQuality.linesOfCode)}`,
      `- Test files: ${delta(current.codeQuality.testCount, previous?.codeQuality.testCount)}`,
      `- Test coverage: ${delta(current.codeQuality.testCoverage, previous?.codeQuality.testCoverage, 1, "%")}`,
      `- Lint errors: ${delta(current.codeQuality.lintErrors, previous?.codeQuality.lintErrors)}`,
      ``,
      `**Knowledge**`,
      `- Total substrate files: ${delta(current.knowledge.totalFiles, previous?.knowledge.totalFiles)}`,
      `- Subdirectory files: ${delta(current.knowledge.subdirectoryFiles, previous?.knowledge.subdirectoryFiles)}`,
      `- @-references: ${delta(current.knowledge.referenceCount, previous?.knowledge.referenceCount)}`,
      `- Avg file age: ${delta(current.knowledge.avgFileAgeDays, previous?.knowledge.avgFileAgeDays, 1, " days")}`,
      ``,
      `**Governance**`,
      `- Drift score: ${delta(current.governance.driftScore, previous?.governance.driftScore, 2)}`,
      `- Audits this period: ${current.governance.auditsThisPeriod}`,
      `- Findings: ${current.governance.findingsThisPeriod} (${current.governance.findingsAddressed} addressed)`,
      `- Remediation rate: ${pct(current.governance.remediationRate)}`,
      ``,
      `**Performance**`,
      `- Avg cycle time: ${current.performance.avgCycleTimeMs}ms`,
      `- Idle rate: ${pct(current.performance.idleRate)}`,
      `- Restarts: ${current.performance.restartsThisPeriod}`,
      `- Rate limit hits: ${current.performance.rateLimitHits}`,
      ``,
      `**Capability**`,
      `- Skills entries: ${delta(current.capability.skillsAdded, previous?.capability.skillsAdded)}`,
      `- Active integrations: ${current.capability.activeIntegrations}`,
      `- Task completion rate: ${pct(current.capability.taskCompletionRate)}`,
    ];

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Private collectors
  // ---------------------------------------------------------------------------

  private async collectCodeQuality(): Promise<CodeQualityMetrics> {
    // Count TypeScript source files (excluding test files and generated dirs)
    const srcFiles = await this.listFilesRecursively(
      this.serverSrcPath,
      ".ts",
      (name) => !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
    );
    const testFiles = await this.listFilesRecursively(this.serverSrcPath, ".test.ts");

    let linesOfCode = 0;
    for (const f of srcFiles) {
      try {
        const content = await this.fs.readFile(f);
        linesOfCode += content.split("\n").length; // counts trailing empty element if file ends with \n (consistent with SubstrateSizeTracker)
      } catch {
        // skip unreadable files
      }
    }

    return {
      linesOfCode,
      testCount: testFiles.length,
      testCoverage: 0,   // requires jest --coverage; not computed here
      lintErrors: 0,     // requires eslint; not computed here
      lintWarnings: 0,
    };
  }

  private async collectKnowledge(): Promise<KnowledgeMetrics> {
    // Count root-level .md files in the substrate directory
    let totalFiles = 0;
    try {
      const rootEntries = await this.fs.readdir(this.substratePath);
      totalFiles = rootEntries.filter((e) => e.endsWith(".md")).length;
    } catch {
      // substrate path doesn't exist
    }

    // Count .md files in known subdirectories
    let subdirectoryFiles = 0;
    for (const subdir of SUBSTRATE_SUBDIRS) {
      try {
        const entries = await this.fs.readdir(path.join(this.substratePath, subdir));
        subdirectoryFiles += entries.filter((e) => e.endsWith(".md")).length;
      } catch {
        // subdirectory doesn't exist
      }
    }

    // Count @-references in index files (e.g. "@memory/topic.md")
    let referenceCount = 0;
    for (const indexFile of SUBSTRATE_INDEX_FILES) {
      try {
        const content = await this.fs.readFile(path.join(this.substratePath, indexFile));
        const matches = content.match(/@[a-zA-Z0-9_\-/.]+\.md/g);
        if (matches) {
          referenceCount += matches.length;
        }
      } catch {
        // file doesn't exist
      }
    }

    // Calculate average file age in days using mtime from index files
    let totalAgeDays = 0;
    let agedFileCount = 0;
    const nowMs = this.clock.now().getTime();
    for (const indexFile of SUBSTRATE_INDEX_FILES) {
      try {
        const stat = await this.fs.stat(path.join(this.substratePath, indexFile));
        const ageDays = Math.max(0, (nowMs - stat.mtimeMs) / (1000 * 60 * 60 * 24));
        totalAgeDays += ageDays;
        agedFileCount++;
      } catch {
        // file doesn't exist
      }
    }

    return {
      totalFiles,
      subdirectoryFiles,
      referenceCount,
      avgFileAgeDays: agedFileCount > 0 ? totalAgeDays / agedFileCount : 0,
    };
  }

  private async collectGovernance(period: string): Promise<GovernanceMetrics> {
    const allReports = await this.reportStore.list();

    // reportStore.list() returns newest first; get drift from latest audit
    let driftScore = 0;
    const latestReport = allReports[0];
    if (latestReport && typeof latestReport.driftScore === "number") {
      driftScore = latestReport.driftScore;
    }

    // Filter reports for the current YYYY-MM period
    const periodReports = allReports.filter((r) => r.timestamp.startsWith(period));
    const auditsThisPeriod = periodReports.length;

    let findingsThisPeriod = 0;
    let findingsAddressed = 0;

    for (const report of periodReports) {
      if (Array.isArray(report.findings)) {
        findingsThisPeriod += report.findings.length;
      }
      if (Array.isArray(report.proposalEvaluations)) {
        findingsAddressed += (report.proposalEvaluations as Array<{ approved: boolean }>)
          .filter((p) => p.approved).length;
      }
    }

    const remediationRate = findingsThisPeriod > 0 ? findingsAddressed / findingsThisPeriod : 0;

    return {
      driftScore,
      auditsThisPeriod,
      findingsThisPeriod,
      findingsAddressed,
      remediationRate,
    };
  }

  private buildPerformance(perf: PerformanceInput): PerformanceMetrics {
    return {
      avgCycleTimeMs: perf.avgCycleTimeMs ?? 0,
      idleRate: perf.idleRate ?? 0,
      restartsThisPeriod: perf.restartsThisPeriod ?? 0,
      rateLimitHits: perf.rateLimitHits ?? 0,
    };
  }

  private async collectCapability(period: string): Promise<CapabilityMetrics> {
    // Count skill list entries in SKILLS.md (lines starting with "- " or "* ")
    let skillsAdded = 0;
    try {
      const content = await this.fs.readFile(path.join(this.substratePath, "SKILLS.md"));
      skillsAdded = content.split("\n").filter((line) => /^[-*]\s/.test(line)).length;
    } catch {
      // SKILLS.md doesn't exist
    }

    // Count active integrations by checking for known config files
    let activeIntegrations = 0;
    const parentDir = path.join(this.substratePath, "..");
    for (const configFile of INTEGRATION_CONFIG_FILES) {
      try {
        if (await this.fs.exists(path.join(parentDir, configFile))) {
          activeIntegrations++;
        }
      } catch {
        // skip
      }
    }

    // Estimate task completion rate from PROGRESS.md entries in the current period
    let taskCompletionRate = 0;
    try {
      const content = await this.fs.readFile(path.join(this.substratePath, "PROGRESS.md"));
      const periodLines = content.split("\n").filter((line) => line.startsWith(`[${period}`));
      const successLines = periodLines.filter((line) => /completed|success|done/i.test(line));
      const failLines = periodLines.filter((line) => /fail|error/i.test(line));
      const total = successLines.length + failLines.length;
      taskCompletionRate = total > 0 ? successLines.length / total : 0;
    } catch {
      // PROGRESS.md doesn't exist
    }

    return {
      skillsAdded,
      activeIntegrations,
      taskCompletionRate,
    };
  }

  /**
   * Recursively list files matching a suffix under a directory,
   * skipping SKIP_DIRS and applying an optional per-filename filter.
   */
  private async listFilesRecursively(
    dir: string,
    suffix: string,
    filter?: (name: string) => boolean
  ): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await this.fs.readdir(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = await this.fs.stat(fullPath);
          if (stat.isDirectory && !SKIP_DIRS.has(entry)) {
            const sub = await this.listFilesRecursively(fullPath, suffix, filter);
            results.push(...sub);
          } else if (stat.isFile && entry.endsWith(suffix)) {
            if (!filter || filter(entry)) {
              results.push(fullPath);
            }
          }
        } catch {
          // skip entries we can't stat
        }
      }
    } catch {
      // directory doesn't exist or can't be read
    }
    return results;
  }
}
