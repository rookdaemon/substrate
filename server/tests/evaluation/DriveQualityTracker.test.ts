import { DriveQualityTracker, DriveRating } from "../../src/evaluation/DriveQualityTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";

describe("DriveQualityTracker", () => {
  let fs: InMemoryFileSystem;
  let tracker: DriveQualityTracker;
  const filePath = "/data/drive-ratings.jsonl";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    tracker = new DriveQualityTracker(fs, filePath);
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
