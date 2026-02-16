import { TaskClassificationMetrics } from "../../src/evaluation/TaskClassificationMetrics";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { AgentRole } from "../../src/agents/types";

describe("TaskClassificationMetrics", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let metrics: TaskClassificationMetrics;
  const substratePath = "/test/substrate";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-16T12:00:00Z"));
    metrics = new TaskClassificationMetrics(fs, clock, substratePath);
    
    // Create substrate directory
    await fs.mkdir(substratePath, { recursive: true });
  });

  describe("recordClassification", () => {
    it("should create metrics file on first write", async () => {
      await metrics.recordClassification(
        AgentRole.EGO,
        "decide",
        "strategic",
        "claude-opus-4-20250514"
      );

      const content = await fs.readFile(`${substratePath}/.metrics/task_classifications.jsonl`);
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);
      
      const entry = JSON.parse(lines[0]);
      expect(entry.timestamp).toBe("2026-02-16T12:00:00.000Z");
      expect(entry.role).toBe("EGO");
      expect(entry.operation).toBe("decide");
      expect(entry.taskType).toBe("strategic");
      expect(entry.model).toBe("claude-opus-4-20250514");
    });

    it("should append multiple classifications", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      
      clock.setNow(new Date("2026-02-16T12:01:00Z"));
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      
      clock.setNow(new Date("2026-02-16T12:02:00Z"));
      await metrics.recordClassification(AgentRole.SUPEREGO, "audit", "strategic", "opus");

      const content = await fs.readFile(`${substratePath}/.metrics/task_classifications.jsonl`);
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3);
      
      const entries = lines.map(line => JSON.parse(line));
      expect(entries[0].operation).toBe("decide");
      expect(entries[1].operation).toBe("execute");
      expect(entries[2].operation).toBe("audit");
    });
  });

  describe("getHistory", () => {
    it("should return empty array when no classifications exist", async () => {
      const history = await metrics.getHistory();
      expect(history).toEqual([]);
    });

    it("should return all classifications", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");

      const history = await metrics.getHistory();
      expect(history.length).toBe(2);
      expect(history[0].operation).toBe("decide");
      expect(history[1].operation).toBe("execute");
    });
  });

  describe("getHistorySince", () => {
    it("should filter classifications by timestamp", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      
      clock.setNow(new Date("2026-02-16T13:00:00Z"));
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      
      clock.setNow(new Date("2026-02-16T14:00:00Z"));
      await metrics.recordClassification(AgentRole.SUPEREGO, "audit", "strategic", "opus");

      const since = new Date("2026-02-16T12:30:00Z");
      const filtered = await metrics.getHistorySince(since);
      
      expect(filtered.length).toBe(2);
      expect(filtered[0].operation).toBe("execute");
      expect(filtered[1].operation).toBe("audit");
    });
  });

  describe("getStats", () => {
    it("should return zero stats when no classifications exist", async () => {
      const stats = await metrics.getStats();
      
      expect(stats.totalOperations).toBe(0);
      expect(stats.strategicCount).toBe(0);
      expect(stats.tacticalCount).toBe(0);
      expect(stats.strategicPct).toBe(0);
      expect(stats.tacticalPct).toBe(0);
    });

    it("should calculate correct percentages", async () => {
      // 2 strategic, 3 tactical = 40% strategic, 60% tactical
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      await metrics.recordClassification(AgentRole.SUPEREGO, "audit", "strategic", "opus");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");

      const stats = await metrics.getStats();
      
      expect(stats.totalOperations).toBe(5);
      expect(stats.strategicCount).toBe(2);
      expect(stats.tacticalCount).toBe(3);
      expect(stats.strategicPct).toBeCloseTo(0.4, 2);
      expect(stats.tacticalPct).toBeCloseTo(0.6, 2);
    });

    it("should group by role", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      await metrics.recordClassification(AgentRole.EGO, "respondToMessage", "strategic", "opus");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");

      const stats = await metrics.getStats();
      
      expect(stats.byRole.EGO.total).toBe(2);
      expect(stats.byRole.EGO.strategic).toBe(2);
      expect(stats.byRole.EGO.tactical).toBe(0);
      
      expect(stats.byRole.SUBCONSCIOUS.total).toBe(2);
      expect(stats.byRole.SUBCONSCIOUS.strategic).toBe(0);
      expect(stats.byRole.SUBCONSCIOUS.tactical).toBe(2);
    });

    it("should support time-based filtering", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      
      clock.setNow(new Date("2026-02-17T12:00:00Z"));
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");
      await metrics.recordClassification(AgentRole.SUBCONSCIOUS, "execute", "tactical", "sonnet");

      const since = new Date("2026-02-17T00:00:00Z");
      const stats = await metrics.getStats(since);
      
      expect(stats.totalOperations).toBe(2); // Only last 2 classifications
      expect(stats.tacticalPct).toBe(1.0); // 100% tactical
    });
  });

  describe("clear", () => {
    it("should remove metrics file", async () => {
      await metrics.recordClassification(AgentRole.EGO, "decide", "strategic", "opus");
      
      const existsBefore = await fs.exists(`${substratePath}/.metrics/task_classifications.jsonl`);
      expect(existsBefore).toBe(true);

      await metrics.clear();
      
      const existsAfter = await fs.exists(`${substratePath}/.metrics/task_classifications.jsonl`);
      expect(existsAfter).toBe(false);
    });
  });
});
