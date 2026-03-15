import * as path from "node:path";
import { IFileSystem } from "../abstractions/IFileSystem";
import { IClock } from "../abstractions/IClock";
import { ReferenceScanner } from "./ReferenceScanner";

export interface BrokenReference {
  file: string;
  reference: string;
}

export interface StaleFile {
  file: string;
  lastModified: string;
  daysSinceUpdate: number;
}

export interface ConsolidationCandidate {
  files: string[];
  reason: string;
}

export interface EagerReferenceCount {
  file: string;
  count: number;
  overLimit: boolean;
}

export interface ValidationReport {
  timestamp: string;
  brokenReferences: BrokenReference[];
  orphanedFiles: string[];
  staleFiles: StaleFile[];
  consolidationCandidates: ConsolidationCandidate[];
  eagerReferenceCounts: EagerReferenceCount[];
}

const INDEX_FILES = ["MEMORY.md", "SKILLS.md", "HABITS.md", "VALUES.md", "ID.md", "SECURITY.md", "challenge_lifecycle_index.md"];
const SUBDIRS = ["memory", "skills", "habits", "values", "id", "security", "challenges"];
const STALE_THRESHOLD_DAYS = 30;
/** Maximum number of eager @-references recommended per index file (R-T2). */
export const MAX_EAGER_REFERENCES = 5;

/** Normalize to posix style so path joins match on all platforms (e.g. tests use posix paths). */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export class SubstrateValidator {
  private readonly scanner = new ReferenceScanner();

  constructor(
    private readonly fs: IFileSystem,
    private readonly dataDir: string,
    private readonly clock: IClock
  ) {}

  async validate(): Promise<ValidationReport> {
    const baseDir = toPosix(this.dataDir);
    const timestamp = this.clock.now().toISOString();
    const report: ValidationReport = {
      timestamp,
      brokenReferences: [],
      orphanedFiles: [],
      staleFiles: [],
      consolidationCandidates: [],
      eagerReferenceCounts: [],
    };

    const allReferences = new Set<string>();

    // 1. Scan index files for @-references and detect broken ones
    for (const indexFile of INDEX_FILES) {
      const fullPath = path.posix.join(baseDir, indexFile);
      if (!(await this.fs.exists(fullPath))) {
        continue;
      }

      let content: string;
      try {
        content = await this.fs.readFile(fullPath);
      } catch {
        continue;
      }

      const refs = this.scanner.extractReferences(content);
      report.eagerReferenceCounts.push({
        file: indexFile,
        count: refs.length,
        overLimit: refs.length > MAX_EAGER_REFERENCES,
      });
      for (const ref of refs) {
        allReferences.add(ref);
        const refPath = path.posix.join(baseDir, ref);
        if (!(await this.fs.exists(refPath))) {
          report.brokenReferences.push({ file: indexFile, reference: ref });
        }
      }
    }

    // 2. Find orphaned files in subdirectories
    for (const subdir of SUBDIRS) {
      const subdirPath = path.posix.join(baseDir, subdir);
      if (!(await this.fs.exists(subdirPath))) {
        continue;
      }

      let entries: string[];
      try {
        entries = await this.fs.readdir(subdirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) {
          continue;
        }
        const relativePath = `${subdir}/${entry}`;
        if (!allReferences.has(relativePath)) {
          report.orphanedFiles.push(relativePath);
        }
      }
    }

    // 3. Detect stale files among referenced files (>30 days unchanged)
    const now = this.clock.now().getTime();
    const staleThresholdMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const ref of allReferences) {
      const refPath = path.posix.join(baseDir, ref);
      let stats;
      try {
        stats = await this.fs.stat(refPath);
      } catch {
        continue;
      }

      const ageMs = now - stats.mtimeMs;
      if (ageMs > staleThresholdMs) {
        const daysSinceUpdate = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        report.staleFiles.push({
          file: ref,
          lastModified: new Date(stats.mtimeMs).toISOString(),
          daysSinceUpdate,
        });
      }
    }

    return report;
  }
}
