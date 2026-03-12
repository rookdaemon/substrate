import * as path from "path";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

export interface DriveRating {
  task: string;
  generatedAt: string; // ISO date string from [ID-generated YYYY-MM-DD] tag
  completedAt: string; // ISO timestamp
  rating: number;      // 0-10
  category: string;
}

/**
 * Persists and queries Id drive quality ratings to enable learning over time.
 * Ratings are stored as newline-delimited JSON (JSONL) for simple append-only writes.
 */
export class DriveQualityTracker {
  constructor(
    private readonly fs: IFileSystem,
    private readonly filePath: string
  ) {}

  async recordRating(rating: DriveRating): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });
    await this.fs.appendFile(this.filePath, JSON.stringify(rating) + "\n");
  }

  async getHistoricalRatings(): Promise<DriveRating[]> {
    if (!(await this.fs.exists(this.filePath))) return [];
    const content = await this.fs.readFile(this.filePath);
    if (!content.trim()) return [];
    return content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DriveRating);
  }

  async getCategoryStats(): Promise<Record<string, { avgRating: number; count: number }>> {
    const ratings = await this.getHistoricalRatings();
    const stats: Record<string, { total: number; count: number }> = {};
    for (const r of ratings) {
      if (!stats[r.category]) stats[r.category] = { total: 0, count: 0 };
      stats[r.category].total += r.rating;
      stats[r.category].count++;
    }
    return Object.fromEntries(
      Object.entries(stats).map(([cat, s]) => [
        cat,
        { avgRating: s.total / s.count, count: s.count },
      ])
    );
  }

  /**
   * Infer a coarse category from a task description for grouping ratings.
   */
  static inferCategory(description: string): string {
    const lower = description.toLowerCase();
    // Adversarial: Bishop-domain terms — checked first to prevent misclassification as reading/writing.
    // PASS is matched on the original to treat it as an acronym and avoid common-word false positives.
    if (
      /\b(challenge|adversarial|ch[45]|pettit|parfit|scanlon)\b|companion document|treatise review|pre-reading|prior position|attribution architecture|review cycle/.test(lower) ||
      /\bPASS\b/.test(description)
    ) return "adversarial";
    if (/\bread(ing|s)?\b/.test(lower)) return "reading";
    if (/\bresearch\b/.test(lower)) return "research";
    if (/\b(write|writing|blog|document|draft)\b/.test(lower)) return "writing";
    if (/\bcoordinat(e|ion|ing)?\b|\bcollaborat(e|ion|ing)?\b|\bcollab\b/.test(lower)) return "coordination";
    if (/\bcurat(e|ion|ing)?\b|\borganiz(e|ation|ing)?\b|\bsort\b|\breview\b/.test(lower)) return "curation";
    return "general";
  }
}
