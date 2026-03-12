import { DrivePatternLearner, CategoryBias } from "../../src/evaluation/DrivePatternLearner";
import { DriveQualityTracker } from "../../src/evaluation/DriveQualityTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";

describe("DrivePatternLearner", () => {
  let fs: InMemoryFileSystem;
  let tracker: DriveQualityTracker;
  let learner: DrivePatternLearner;
  const filePath = "/data/drive-ratings.jsonl";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    tracker = new DriveQualityTracker(fs, filePath);
    learner = new DrivePatternLearner(tracker);
  });

  const record = async (category: string, rating: number, count = 1): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await tracker.recordRating({
        task: `Task for ${category}`,
        generatedAt: "2026-03-12",
        completedAt: "2026-03-12T10:00:00.000Z",
        rating,
        category,
      });
    }
  };

  describe("computeBiasMultipliers", () => {
    it("returns empty record when no ratings exist", async () => {
      const result = await learner.computeBiasMultipliers();
      expect(result).toEqual({});
    });

    it("returns a multiplier of 1.0 for a single category (equals overall average)", async () => {
      await fs.mkdir("/data", { recursive: true });
      await record("reading", 7, 3);

      const result = await learner.computeBiasMultipliers();
      expect(result.reading.multiplier).toBeCloseTo(1.0);
      expect(result.reading.effectiveness).toBeCloseTo(0.7);
      expect(result.reading.sampleCount).toBe(3);
    });

    it("amplifies categories with above-average ratings", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (8*2 + 4*2) / 4 = 6
      await record("research", 8, 2); // relative: 8/6 ≈ 1.33
      await record("writing", 4, 2);  // relative: 4/6 ≈ 0.67

      const result = await learner.computeBiasMultipliers();
      expect(result.research.multiplier).toBeGreaterThan(1.0);
      expect(result.writing.multiplier).toBeLessThan(1.0);
    });

    it("clamps multiplier at 1.8 ceiling for very high-quality categories", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (10*5 + 1*5) / 10 = 5.5
      // research relative: 10/5.5 ≈ 1.82 → clamped to 1.8
      await record("research", 10, 5);
      await record("writing", 1, 5);

      const result = await learner.computeBiasMultipliers();
      expect(result.research.multiplier).toBe(1.8);
    });

    it("clamps multiplier at 0.3 floor for very low-quality categories", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (10*5 + 1*5) / 10 = 5.5
      // writing relative: 1/5.5 ≈ 0.18 → clamped to 0.3
      await record("research", 10, 5);
      await record("writing", 1, 5);

      const result = await learner.computeBiasMultipliers();
      expect(result.writing.multiplier).toBe(0.3);
    });

    it("does NOT clamp multipliers within the old 0.6–1.4 range (no behaviour change)", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (8*2 + 5*2) / 4 = 6.5
      // research: 8/6.5 ≈ 1.23 (within both old and new range)
      // writing:  5/6.5 ≈ 0.77 (within both old and new range)
      await record("research", 8, 2);
      await record("writing", 5, 2);

      const result = await learner.computeBiasMultipliers();
      expect(result.research.multiplier).toBeGreaterThan(0.6);
      expect(result.research.multiplier).toBeLessThan(1.4);
      expect(result.writing.multiplier).toBeGreaterThan(0.6);
      expect(result.writing.multiplier).toBeLessThan(1.4);
    });

    it("allows multipliers in the extended range above 1.4", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (9*3 + 2*3) / 6 = 5.5; research = 9/5.5 ≈ 1.636 (in 1.4–1.8 range)
      await record("research", 9, 3);
      await record("curation", 2, 3);

      const result = await learner.computeBiasMultipliers();
      expect(result.research.multiplier).toBeGreaterThan(1.4); // would have been capped in old range
      expect(result.research.multiplier).toBeLessThanOrEqual(1.8);
    });

    it("allows multipliers in the extended range below 0.6", async () => {
      await fs.mkdir("/data", { recursive: true });
      // overall avg = (9*3 + 2*3) / 6 = 5.5; curation = 2/5.5 ≈ 0.36 (in 0.3–0.6 range)
      await record("research", 9, 3);
      await record("curation", 2, 3);

      const result = await learner.computeBiasMultipliers();
      expect(result.curation.multiplier).toBeLessThan(0.6); // would have been capped in old range
      expect(result.curation.multiplier).toBeGreaterThanOrEqual(0.3);
    });

    it("populates effectiveness as avgRating / 10", async () => {
      await fs.mkdir("/data", { recursive: true });
      await record("writing", 9, 2);
      await record("reading", 6, 2);

      const result = await learner.computeBiasMultipliers();
      expect(result.writing.effectiveness).toBeCloseTo(0.9);
      expect(result.reading.effectiveness).toBeCloseTo(0.6);
    });

    it("includes sampleCount for each category", async () => {
      await fs.mkdir("/data", { recursive: true });
      await record("writing", 7, 5);
      await record("reading", 8, 2);

      const result = await learner.computeBiasMultipliers();
      expect(result.writing.sampleCount).toBe(5);
      expect(result.reading.sampleCount).toBe(2);
    });
  });
});
