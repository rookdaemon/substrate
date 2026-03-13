import { DriveQualityTracker, DriveRating } from "../../src/evaluation/DriveQualityTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../src/logging";

describe("DriveQualityTracker", () => {
  let fs: InMemoryFileSystem;
  let logger: InMemoryLogger;
  let tracker: DriveQualityTracker;
  const filePath = "/data/drive-ratings.jsonl";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    logger = new InMemoryLogger();
    tracker = new DriveQualityTracker(fs, filePath, logger);
  });

  const makeRating = (overrides: Partial<DriveRating> = {}): DriveRating => ({
    task: "Read papers on alignment [ID-generated 2026-02-20]",
    generatedAt: "2026-02-20",
    completedAt: "2026-02-20T12:00:00.000Z",
    rating: 7,
    category: "reading",
    ...overrides,
  });

  describe("recordRating", () => {
    it("creates the data directory and appends JSONL to the file", async () => {
      await fs.mkdir("/data", { recursive: true });
      await tracker.recordRating(makeRating({ rating: 8 }));

      const content = await fs.readFile(filePath);
      const parsed = JSON.parse(content.trim());
      expect(parsed.rating).toBe(8);
      expect(parsed.category).toBe("reading");
    });

    it("appends multiple ratings as separate JSONL lines", async () => {
      await fs.mkdir("/data", { recursive: true });
      await tracker.recordRating(makeRating({ rating: 6 }));
      await tracker.recordRating(makeRating({ rating: 9, category: "research" }));

      const content = await fs.readFile(filePath);
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).rating).toBe(6);
      expect(JSON.parse(lines[1]).rating).toBe(9);
    });

    describe("Guard A — loop detection", () => {
      it("does not warn when daily count is at or below 100", async () => {
        await fs.mkdir("/data", { recursive: true });
        // Pre-seed exactly 100 ratings for the target date
        const seed = Array.from({ length: 100 }, () =>
          JSON.stringify(makeRating({ completedAt: "2026-03-02T10:00:00.000Z" }))
        ).join("\n") + "\n";
        await fs.appendFile(filePath, seed);

        await tracker.recordRating(makeRating({ completedAt: "2026-03-02T10:00:00.000Z" }));
        expect(logger.getWarnEntries()).toHaveLength(0);
      });

      it("emits a warning when daily count exceeds 100 but still records the rating", async () => {
        await fs.mkdir("/data", { recursive: true });
        // Pre-seed 101 ratings for the target date so next call sees > 100
        const seed = Array.from({ length: 101 }, () =>
          JSON.stringify(makeRating({ completedAt: "2026-03-02T10:00:00.000Z" }))
        ).join("\n") + "\n";
        await fs.appendFile(filePath, seed);

        await tracker.recordRating(makeRating({ completedAt: "2026-03-02T10:00:00.000Z" }));
        expect(logger.getWarnEntries()).toContain(
          "DriveQualityTracker: >100 ratings recorded today — possible loop artifact"
        );
        const ratings = await tracker.getHistoricalRatings();
        expect(ratings).toHaveLength(102);
      });

      it("only counts ratings for the same date when checking the daily limit", async () => {
        await fs.mkdir("/data", { recursive: true });
        // Pre-seed 101 ratings for one date (guard would fire for that date)
        const seed = Array.from({ length: 101 }, () =>
          JSON.stringify(makeRating({ completedAt: "2026-03-01T10:00:00.000Z" }))
        ).join("\n") + "\n";
        await fs.appendFile(filePath, seed);

        // Recording for a different date: daily count for 2026-03-02 is 0, no guard
        await tracker.recordRating(makeRating({ completedAt: "2026-03-02T10:00:00.000Z" }));
        expect(logger.getWarnEntries()).toHaveLength(0);
      });
    });

    describe("Guard B — retry loop deduplication", () => {
      const lowRatingTask = "Do a task [ID-generated 2026-02-20]";

      it("records the first low rating normally", async () => {
        await fs.mkdir("/data", { recursive: true });
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        const ratings = await tracker.getHistoricalRatings();
        expect(ratings).toHaveLength(1);
        expect(logger.getWarnEntries()).toHaveLength(0);
      });

      it("records up to (threshold - 1) low ratings without skipping", async () => {
        await fs.mkdir("/data", { recursive: true });
        // Default threshold is 3 — recording 2 should still work
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        const ratings = await tracker.getHistoricalRatings();
        expect(ratings).toHaveLength(2);
        expect(logger.getWarnEntries()).toHaveLength(0);
      });

      it("skips and warns when the same task hits the low-rating threshold", async () => {
        await fs.mkdir("/data", { recursive: true });
        // Record 3 ratings of 3/10 for the same task (at threshold)
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));

        // Fourth attempt for the same task at 3/10 should be skipped
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));

        const ratings = await tracker.getHistoricalRatings();
        expect(ratings).toHaveLength(3);
        expect(logger.getWarnEntries()).toContain(
          "DriveQualityTracker: duplicate low-rating for task — skipping retry loop artifact"
        );
      });

      it("does not skip non-3 ratings for a task that has many 3/10 ratings", async () => {
        await fs.mkdir("/data", { recursive: true });
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));

        // A different rating value for the same task should still be recorded
        await tracker.recordRating(makeRating({ task: lowRatingTask, rating: 5 }));

        const ratings = await tracker.getHistoricalRatings();
        expect(ratings).toHaveLength(4);
      });

      it("respects a custom duplicate low-rating threshold", async () => {
        const strictTracker = new DriveQualityTracker(fs, filePath, logger, 2);
        await fs.mkdir("/data", { recursive: true });
        await strictTracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));
        await strictTracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));

        // With threshold=2, the third recording should be skipped
        await strictTracker.recordRating(makeRating({ task: lowRatingTask, rating: 3 }));

        const ratings = await strictTracker.getHistoricalRatings();
        expect(ratings).toHaveLength(2);
        expect(logger.getWarnEntries()).toContain(
          "DriveQualityTracker: duplicate low-rating for task — skipping retry loop artifact"
        );
      });
    });
  });

  describe("getHistoricalRatings", () => {
    it("returns empty array when file does not exist", async () => {
      const ratings = await tracker.getHistoricalRatings();
      expect(ratings).toEqual([]);
    });

    it("returns all persisted ratings", async () => {
      await fs.mkdir("/data", { recursive: true });
      await tracker.recordRating(makeRating({ rating: 5 }));
      await tracker.recordRating(makeRating({ rating: 8, category: "writing" }));

      const ratings = await tracker.getHistoricalRatings();
      expect(ratings).toHaveLength(2);
      expect(ratings[0].rating).toBe(5);
      expect(ratings[1].category).toBe("writing");
    });
  });

  describe("getCategoryStats", () => {
    it("returns empty object when no ratings exist", async () => {
      const stats = await tracker.getCategoryStats();
      expect(stats).toEqual({});
    });

    it("computes average rating and count per category", async () => {
      await fs.mkdir("/data", { recursive: true });
      await tracker.recordRating(makeRating({ rating: 6, category: "reading" }));
      await tracker.recordRating(makeRating({ rating: 8, category: "reading" }));
      await tracker.recordRating(makeRating({ rating: 4, category: "coordination" }));

      const stats = await tracker.getCategoryStats();
      expect(stats.reading.avgRating).toBe(7);
      expect(stats.reading.count).toBe(2);
      expect(stats.coordination.avgRating).toBe(4);
      expect(stats.coordination.count).toBe(1);
    });
  });

  describe("inferCategory", () => {
    it("classifies adversarial tasks by keyword", () => {
      expect(DriveQualityTracker.inferCategory("Bishop adversarial review of Ch4")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("pre-reading prior position for Pettit")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("challenge construction for companion document")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("treatise review for Parfit Ch5")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("PASS evaluation with Scanlon attribution architecture")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("review cycle on prior position")).toBe("adversarial");
    });

    it("classifies adversarial protocol markers (rebuttal, resolution, stress-test)", () => {
      expect(DriveQualityTracker.inferCategory("Write rebuttal to Bishop's challenge")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("Draft resolution after adversarial review")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("stress-test argument for robustness")).toBe("adversarial");
      expect(DriveQualityTracker.inferCategory("Stress test Bishop's position on autonomy")).toBe("adversarial");
    });

    it("classifies reading tasks", () => {
      expect(DriveQualityTracker.inferCategory("Read papers on alignment")).toBe("reading");
      expect(DriveQualityTracker.inferCategory("Reading session on AGI safety")).toBe("reading");
    });

    it("classifies research tasks", () => {
      expect(DriveQualityTracker.inferCategory("Research embodiment literature")).toBe("research");
    });

    it("classifies writing tasks", () => {
      expect(DriveQualityTracker.inferCategory("Write a blog post")).toBe("writing");
      expect(DriveQualityTracker.inferCategory("Document the API")).toBe("writing");
      expect(DriveQualityTracker.inferCategory("Draft release notes")).toBe("writing");
    });

    it("classifies coordination tasks", () => {
      expect(DriveQualityTracker.inferCategory("Coordinate with Bishop on plan")).toBe("coordination");
    });

    it("classifies curation tasks", () => {
      expect(DriveQualityTracker.inferCategory("Curate memory files")).toBe("curation");
      expect(DriveQualityTracker.inferCategory("Review and organize notes")).toBe("curation");
    });

    it("defaults to general for unrecognized patterns", () => {
      expect(DriveQualityTracker.inferCategory("Do some random thing")).toBe("general");
    });
  });
});
