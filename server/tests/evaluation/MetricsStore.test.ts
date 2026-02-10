import { MetricsStore } from "../../src/evaluation/MetricsStore";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("MetricsStore", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let store: MetricsStore;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-10T12:00:00Z"));
    store = new MetricsStore(fs, clock, "/substrate");

    await fs.mkdir("/substrate", { recursive: true });
  });

  describe("record()", () => {
    it("creates .metrics directory on first record", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      const exists = await fs.exists("/substrate/.metrics");
      expect(exists).toBe(true);
    });

    it("appends metrics to JSONL file with timestamp", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      const content = await fs.readFile("/substrate/.metrics/health_metrics.jsonl", "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry).toEqual({
        driftScore: 0.1,
        consistencyScore: 0.9,
        securityScore: 1.0,
        timestamp: "2026-02-10T12:00:00.000Z",
      });
    });

    it("appends multiple metrics as separate lines", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      clock.setNow(new Date("2026-02-10T13:00:00Z"));
      await store.record({ driftScore: 0.2, consistencyScore: 0.8, securityScore: 0.9 });

      const content = await fs.readFile("/substrate/.metrics/health_metrics.jsonl", "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).timestamp).toBe("2026-02-10T12:00:00.000Z");
      expect(JSON.parse(lines[1]).timestamp).toBe("2026-02-10T13:00:00.000Z");
    });

    it("caches metrics in memory", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.2, consistencyScore: 0.8, securityScore: 0.9 });

      const history = await store.getHistory();
      expect(history).toHaveLength(2);
    });

    it("keeps cache bounded to 100 entries", async () => {
      for (let i = 0; i < 105; i++) {
        await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      }

      // Cache is bounded but getHistory defaults to 50
      const history = await store.getHistory(150); // Request more than 100
      expect(history).toHaveLength(100);
    });
  });

  describe("setBaseline()", () => {
    it("creates baseline.json with timestamp", async () => {
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });

      const content = await fs.readFile("/substrate/.metrics/baseline.json", "utf8");
      const baseline = JSON.parse(content);

      expect(baseline).toEqual({
        driftScore: 0.05,
        consistencyScore: 0.95,
        securityScore: 1.0,
        establishedAt: "2026-02-10T12:00:00.000Z",
      });
    });

    it("caches baseline in memory", async () => {
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });

      const baseline = await store.getBaseline();
      expect(baseline?.driftScore).toBe(0.05);
    });
  });

  describe("getBaseline()", () => {
    it("returns null when no baseline exists", async () => {
      const baseline = await store.getBaseline();
      expect(baseline).toBeNull();
    });

    it("loads baseline from file on first access", async () => {
      await fs.mkdir("/substrate/.metrics", { recursive: true });
      await fs.writeFile(
        "/substrate/.metrics/baseline.json",
        JSON.stringify({
          driftScore: 0.05,
          consistencyScore: 0.95,
          securityScore: 1.0,
          establishedAt: "2026-02-10T10:00:00.000Z",
        }),
        "utf8"
      );

      const baseline = await store.getBaseline();
      expect(baseline?.driftScore).toBe(0.05);
    });

    it("uses cache on subsequent accesses", async () => {
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });

      // Modify file directly
      await fs.writeFile(
        "/substrate/.metrics/baseline.json",
        JSON.stringify({
          driftScore: 0.99,
          consistencyScore: 0.01,
          securityScore: 0.0,
          establishedAt: "2026-02-10T10:00:00.000Z",
        }),
        "utf8"
      );

      // Should still get cached value
      const baseline = await store.getBaseline();
      expect(baseline?.driftScore).toBe(0.05);
    });
  });

  describe("getHistory()", () => {
    it("returns empty array when no metrics exist", async () => {
      const history = await store.getHistory();
      expect(history).toEqual([]);
    });

    it("returns recent metrics (default: last 50)", async () => {
      for (let i = 0; i < 60; i++) {
        await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      }

      const history = await store.getHistory();
      expect(history).toHaveLength(50);
    });

    it("respects custom limit", async () => {
      for (let i = 0; i < 20; i++) {
        await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      }

      const history = await store.getHistory(10);
      expect(history).toHaveLength(10);
    });

    it("loads from file if cache is empty", async () => {
      await fs.mkdir("/substrate/.metrics", { recursive: true });
      await fs.writeFile(
        "/substrate/.metrics/health_metrics.jsonl",
        '{"driftScore":0.1,"consistencyScore":0.9,"securityScore":1.0,"timestamp":"2026-02-10T12:00:00.000Z"}\n',
        "utf8"
      );

      const newStore = new MetricsStore(fs, clock, "/substrate");
      const history = await newStore.getHistory();

      expect(history).toHaveLength(1);
      expect(history[0].driftScore).toBe(0.1);
    });
  });

  describe("analyzeTrends()", () => {
    it("returns stable trends with no alerts when no baseline exists", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.driftTrend).toBe("stable");
      expect(trends.consistencyTrend).toBe("stable");
      expect(trends.securityTrend).toBe("stable");
      expect(trends.alerts).toHaveLength(0);
    });

    it("returns stable trends when insufficient history (< 3 data points)", async () => {
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.driftTrend).toBe("stable");
      expect(trends.alerts).toHaveLength(0);
    });

    it("detects improving drift trend (lower is better)", async () => {
      await store.setBaseline({ driftScore: 0.3, consistencyScore: 0.9, securityScore: 1.0 });

      // Recent trend: drift decreasing (improving)
      await store.record({ driftScore: 0.25, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.20, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.15, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();
      expect(trends.driftTrend).toBe("improving");
    });

    it("detects degrading drift trend (higher is worse)", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Recent trend: drift increasing (degrading)
      await store.record({ driftScore: 0.15, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.20, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.25, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();
      expect(trends.driftTrend).toBe("degrading");
    });

    it("detects improving consistency trend (higher is better)", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.7, securityScore: 1.0 });

      await store.record({ driftScore: 0.1, consistencyScore: 0.75, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.80, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.85, securityScore: 1.0 });

      const trends = await store.analyzeTrends();
      expect(trends.consistencyTrend).toBe("improving");
    });

    it("detects degrading consistency trend (lower is worse)", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      await store.record({ driftScore: 0.1, consistencyScore: 0.85, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.80, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.70, securityScore: 1.0 });

      const trends = await store.analyzeTrends();
      expect(trends.consistencyTrend).toBe("degrading");
    });

    it("generates warning alert for moderate drift increase", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Increase drift by 20% (above 15% warning threshold)
      await store.record({ driftScore: 0.3, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.3, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.3, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.alerts).toHaveLength(1);
      expect(trends.alerts[0]).toMatchObject({
        metric: "drift",
        severity: "warning",
        currentValue: 0.3,
        baselineValue: 0.1,
      });
    });

    it("generates critical alert for severe drift increase", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Increase drift by 35% (above 30% critical threshold)
      await store.record({ driftScore: 0.45, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.45, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.45, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.alerts).toHaveLength(1);
      expect(trends.alerts[0]).toMatchObject({
        metric: "drift",
        severity: "critical",
        currentValue: 0.45,
        baselineValue: 0.1,
      });
    });

    it("generates warning alert for consistency decrease", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Decrease consistency by 20% (above 15% warning threshold)
      await store.record({ driftScore: 0.1, consistencyScore: 0.7, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.7, securityScore: 1.0 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.7, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.alerts).toHaveLength(1);
      expect(trends.alerts[0].metric).toBe("consistency");
      expect(trends.alerts[0].severity).toBe("warning");
      expect(trends.alerts[0].baselineValue).toBe(0.9);
      expect(trends.alerts[0].currentValue).toBeCloseTo(0.7, 1);
    });

    it("generates critical alert for security score decrease", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Decrease security by 35% (above 30% critical threshold)
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 0.65 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 0.65 });
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 0.65 });

      const trends = await store.analyzeTrends();

      expect(trends.alerts).toHaveLength(1);
      expect(trends.alerts[0]).toMatchObject({
        metric: "security",
        severity: "critical",
        currentValue: 0.65,
        baselineValue: 1.0,
      });
    });

    it("generates multiple alerts for multiple metrics", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // Degrade all metrics
      await store.record({ driftScore: 0.5, consistencyScore: 0.6, securityScore: 0.6 });
      await store.record({ driftScore: 0.5, consistencyScore: 0.6, securityScore: 0.6 });
      await store.record({ driftScore: 0.5, consistencyScore: 0.6, securityScore: 0.6 });

      const trends = await store.analyzeTrends();

      expect(trends.alerts.length).toBeGreaterThanOrEqual(3);
      expect(trends.alerts.map(a => a.metric).sort()).toEqual(["consistency", "drift", "security"]);
    });

    it("uses custom thresholds from config", async () => {
      const customStore = new MetricsStore(fs, clock, "/substrate", {
        warningThreshold: 0.05, // Very sensitive
        criticalThreshold: 0.10,
      });

      await customStore.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // 7% increase (above 5% warning threshold)
      await customStore.record({ driftScore: 0.17, consistencyScore: 0.9, securityScore: 1.0 });
      await customStore.record({ driftScore: 0.17, consistencyScore: 0.9, securityScore: 1.0 });
      await customStore.record({ driftScore: 0.17, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await customStore.analyzeTrends();

      expect(trends.alerts).toHaveLength(1);
      expect(trends.alerts[0].severity).toBe("warning");
    });

    it("considers stable within 5% threshold", async () => {
      await store.setBaseline({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });

      // 4% increase (below 5% stable threshold)
      await store.record({ driftScore: 0.14, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.14, consistencyScore: 0.9, securityScore: 1.0 });
      await store.record({ driftScore: 0.14, consistencyScore: 0.9, securityScore: 1.0 });

      const trends = await store.analyzeTrends();

      expect(trends.driftTrend).toBe("stable");
      expect(trends.alerts).toHaveLength(0);
    });
  });

  describe("clear()", () => {
    it("removes metrics and baseline files", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });

      await store.clear();

      const metricsExists = await fs.exists("/substrate/.metrics/health_metrics.jsonl");
      const baselineExists = await fs.exists("/substrate/.metrics/baseline.json");

      expect(metricsExists).toBe(false);
      expect(baselineExists).toBe(false);
    });

    it("clears in-memory cache", async () => {
      await store.record({ driftScore: 0.1, consistencyScore: 0.9, securityScore: 1.0 });
      await store.setBaseline({ driftScore: 0.05, consistencyScore: 0.95, securityScore: 1.0 });

      await store.clear();

      const history = await store.getHistory();
      const baseline = await store.getBaseline();

      expect(history).toEqual([]);
      expect(baseline).toBeNull();
    });

    it("handles non-existent files gracefully", async () => {
      await expect(store.clear()).resolves.not.toThrow();
    });
  });
});
