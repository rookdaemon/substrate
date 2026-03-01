import { PerformanceMetrics, CycleEvent, ApiCallEvent, SubstrateIoEvent } from "../../src/evaluation/PerformanceMetrics";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("PerformanceMetrics", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let metrics: PerformanceMetrics;
  const substratePath = "/test/substrate";
  const metricsPath = `${substratePath}/.metrics/performance.jsonl`;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-27T12:00:00Z"));
    metrics = new PerformanceMetrics(fs, clock, substratePath, 1); // bufferSize=1 for immediate writes in tests
    await fs.mkdir(substratePath, { recursive: true });
  });

  describe("recordCycleComplete()", () => {
    it("creates the .metrics directory on first write", async () => {
      await metrics.recordCycleComplete(1, "dispatch", 5000, true);

      const exists = await fs.exists(`${substratePath}/.metrics`);
      expect(exists).toBe(true);
    });

    it("writes a cycle event as a JSONL line", async () => {
      await metrics.recordCycleComplete(1, "dispatch", 5000, true);

      const content = await fs.readFile(metricsPath);
      const entry = JSON.parse(content.trim()) as CycleEvent;

      expect(entry.eventType).toBe("cycle");
      expect(entry.cycleNumber).toBe(1);
      expect(entry.action).toBe("dispatch");
      expect(entry.durationMs).toBe(5000);
      expect(entry.success).toBe(true);
      expect(entry.timestamp).toBe("2026-02-27T12:00:00.000Z");
    });

    it("records idle cycles correctly", async () => {
      await metrics.recordCycleComplete(3, "idle", 100, true);

      const content = await fs.readFile(metricsPath);
      const entry = JSON.parse(content.trim()) as CycleEvent;

      expect(entry.action).toBe("idle");
      expect(entry.success).toBe(true);
    });

    it("records failed dispatch cycles correctly", async () => {
      await metrics.recordCycleComplete(7, "dispatch", 60000, false);

      const content = await fs.readFile(metricsPath);
      const entry = JSON.parse(content.trim()) as CycleEvent;

      expect(entry.success).toBe(false);
      expect(entry.durationMs).toBe(60000);
    });

    it("appends multiple cycle events as separate lines", async () => {
      await metrics.recordCycleComplete(1, "dispatch", 5000, true);
      clock.setNow(new Date("2026-02-27T12:01:00Z"));
      await metrics.recordCycleComplete(2, "idle", 100, true);
      clock.setNow(new Date("2026-02-27T12:02:00Z"));
      await metrics.recordCycleComplete(3, "dispatch", 7200, false);

      const events = await metrics.readEvents();
      expect(events).toHaveLength(3);
      expect((events[0] as CycleEvent).cycleNumber).toBe(1);
      expect((events[1] as CycleEvent).action).toBe("idle");
      expect((events[2] as CycleEvent).success).toBe(false);
    });
  });

  describe("recordApiCall()", () => {
    it("writes an api_call event as a JSONL line", async () => {
      await metrics.recordApiCall(45000, "SUBCONSCIOUS", "execute");

      const content = await fs.readFile(metricsPath);
      const entry = JSON.parse(content.trim()) as ApiCallEvent;

      expect(entry.eventType).toBe("api_call");
      expect(entry.durationMs).toBe(45000);
      expect(entry.metadata.role).toBe("SUBCONSCIOUS");
      expect(entry.metadata.operation).toBe("execute");
      expect(entry.timestamp).toBe("2026-02-27T12:00:00.000Z");
    });

    it("can record multiple API call events from different roles", async () => {
      await metrics.recordApiCall(30000, "SUBCONSCIOUS", "execute");
      await metrics.recordApiCall(1500, "EGO", "dispatchNext");

      const events = await metrics.readEvents();
      expect(events).toHaveLength(2);

      const [first, second] = events as ApiCallEvent[];
      expect(first.metadata.role).toBe("SUBCONSCIOUS");
      expect(second.metadata.role).toBe("EGO");
    });
  });

  describe("recordSubstrateIo()", () => {
    it("writes a substrate_io event as a JSONL line", async () => {
      await metrics.recordSubstrateIo(50, "read", "PLAN.md");

      const content = await fs.readFile(metricsPath);
      const entry = JSON.parse(content.trim()) as SubstrateIoEvent;

      expect(entry.eventType).toBe("substrate_io");
      expect(entry.durationMs).toBe(50);
      expect(entry.metadata.operation).toBe("read");
      expect(entry.metadata.file).toBe("PLAN.md");
      expect(entry.timestamp).toBe("2026-02-27T12:00:00.000Z");
    });
  });

  describe("readEvents()", () => {
    it("returns empty array when file does not exist", async () => {
      const events = await metrics.readEvents();
      expect(events).toEqual([]);
    });

    it("returns mixed event types in order", async () => {
      await metrics.recordCycleComplete(1, "dispatch", 5000, true);
      await metrics.recordApiCall(45000, "SUBCONSCIOUS", "execute");
      await metrics.recordSubstrateIo(50, "write", "MEMORY.md");

      const events = await metrics.readEvents();
      expect(events).toHaveLength(3);
      expect(events[0].eventType).toBe("cycle");
      expect(events[1].eventType).toBe("api_call");
      expect(events[2].eventType).toBe("substrate_io");
    });

    it("returns empty array when file is empty", async () => {
      await fs.mkdir(`${substratePath}/.metrics`, { recursive: true });
      await fs.writeFile(metricsPath, "");

      const events = await metrics.readEvents();
      expect(events).toEqual([]);
    });
  });

  describe("error resilience", () => {
    it("does not throw when directory creation fails (best-effort)", async () => {
      // Create a file at the .metrics path to simulate a collision
      await fs.writeFile(`${substratePath}/.metrics`, "not-a-directory");

      // Should not throw — best-effort
      await expect(
        metrics.recordCycleComplete(1, "dispatch", 5000, true)
      ).resolves.not.toThrow();
    });
  });
});
