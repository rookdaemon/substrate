import * as path from "path";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";

export interface DriveRating {
  task: string;
  generatedAt: string; // ISO date string from [ID-generated YYYY-MM-DD] tag
  completedAt: string; // ISO timestamp
  rating: number;      // 0-10
  category: string;
}

const DAILY_RATING_WARN_THRESHOLD = 100;
const DUPLICATE_LOW_RATING_VALUE = 3;

/**
 * Persists and queries Id drive quality ratings to enable learning over time.
 * Ratings are stored as newline-delimited JSON (JSONL) for simple append-only writes.
 */
export class DriveQualityTracker {
  private readonly duplicateLowRatingThreshold: number;

  constructor(
    private readonly fs: IFileSystem,
    private readonly filePath: string,
    private readonly logger?: ILogger,
    duplicateLowRatingThreshold = 3
  ) {
    this.duplicateLowRatingThreshold = duplicateLowRatingThreshold;
  }

  async recordRating(rating: DriveRating): Promise<void> {
    const existing = await this.getHistoricalRatings();

    // Single pass over existing ratings to collect both guard metrics
    const todayDate = rating.completedAt.slice(0, 10);
    let dailyCount = 0;
    let duplicateLowCount = 0;
    for (const r of existing) {
      if (r.completedAt.startsWith(todayDate)) dailyCount++;
      if (r.task === rating.task && r.rating === DUPLICATE_LOW_RATING_VALUE) duplicateLowCount++;
    }

    // Guard A — Loop detection: warn if more than 100 ratings have already been
    // recorded for the same date (completedAt date prefix). Still records the entry.
    if (dailyCount > DAILY_RATING_WARN_THRESHOLD) {
      this.logger?.warn(
        "DriveQualityTracker: >100 ratings recorded today — possible loop artifact"
      );
    }

    // Guard B — Retry loop deduplication: skip recording if the same task has already
    // been rated exactly 3/10 at or above the configured threshold.
    if (rating.rating === DUPLICATE_LOW_RATING_VALUE && duplicateLowCount >= this.duplicateLowRatingThreshold) {
      this.logger?.warn(
        "DriveQualityTracker: duplicate low-rating for task — skipping retry loop artifact"
      );
      return;
    }

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
      /\b(challenge|adversarial|rebuttal|resolution|stress.?test|ch[45]|pettit|parfit|scanlon)\b|companion document|treatise review|pre-reading|prior position|attribution architecture|review cycle/.test(lower) ||
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
