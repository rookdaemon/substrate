import { DriveQualityTracker } from "./DriveQualityTracker";

export interface CategoryBias {
  category: string;
  /** Clamped to [0.3, 1.8]: values below 1.0 suppress, above 1.0 amplify */
  multiplier: number;
  /** Normalised 0–1 scale (avgRating / 10) */
  effectiveness: number;
  sampleCount: number;
}

/**
 * Learns from historical drive quality ratings to produce per-category bias
 * multipliers.  The multipliers are used to rebalance task-selection
 * probabilities: categories with below-average quality receive a multiplier
 * below 1.0 (suppressed), those above receive a multiplier above 1.0
 * (amplified).
 *
 * The asymmetric clamp [0.3, 1.8] allows stronger downward correction than
 * upward boost, which is appropriate when over-represented low-value
 * categories need heavy suppression.
 */
export class DrivePatternLearner {
  constructor(private readonly tracker: DriveQualityTracker) {}

  async computeBiasMultipliers(): Promise<Record<string, CategoryBias>> {
    const stats = await this.tracker.getCategoryStats();
    const entries = Object.entries(stats);
    if (entries.length === 0) return {};

    // Weighted overall average rating across all categories
    const totalWeightedRating = entries.reduce(
      (sum, [, s]) => sum + s.avgRating * s.count,
      0
    );
    const totalCount = entries.reduce((sum, [, s]) => sum + s.count, 0);
    const overallAvgRating = totalCount > 0 ? totalWeightedRating / totalCount : 5;

    const result: Record<string, CategoryBias> = {};

    for (const [category, stat] of entries) {
      const effectiveness = stat.avgRating / 10;

      // Multiplier is the category's average rating relative to the overall
      // average.  A category rated half the overall average gets 0.5×, one
      // rated twice as high gets 2×, before clamping.
      const calculatedMultiplier =
        overallAvgRating > 0 ? stat.avgRating / overallAvgRating : 1.0;

      const multiplier = Math.max(0.3, Math.min(1.8, calculatedMultiplier));

      result[category] = {
        category,
        multiplier,
        effectiveness,
        sampleCount: stat.count,
      };
    }

    return result;
  }
}
