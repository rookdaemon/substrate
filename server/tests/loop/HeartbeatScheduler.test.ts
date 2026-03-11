import { HeartbeatScheduler } from "../../src/loop/HeartbeatScheduler";
import { AgoraPeerMessageCondition } from "../../src/loop/AgoraPeerMessageCondition";
import { PeerAvailabilityCondition } from "../../src/loop/PeerAvailabilityCondition";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";
import type { IConversationManager } from "../../src/conversation/IConversationManager";
import type { AgentRole } from "../../src/agents/types";
import type { IConditionEvaluator } from "../../src/loop/IConditionEvaluator";
import type { IMessageInjector } from "../../src/loop/IMessageInjector";

class MockConversationManager implements IConversationManager {
  public appendedEntries: Array<{ role: AgentRole; entry: string }> = [];
  async append(role: AgentRole, entry: string): Promise<void> {
    this.appendedEntries.push({ role, entry });
  }
}

class MockMessageInjector implements IMessageInjector {
  public injectedMessages: string[] = [];
  injectMessage(message: string): boolean {
    this.injectedMessages.push(message);
    return false;
  }
}

const HEARTBEAT_PATH = "/substrate/HEARTBEAT.md";

function makeScheduler(
  fs: InMemoryFileSystem,
  clock: FixedClock,
  conversationManager: MockConversationManager,
  evaluators?: Map<string, IConditionEvaluator>,
  messageInjector?: IMessageInjector
): HeartbeatScheduler {
  return new HeartbeatScheduler(
    fs,
    clock,
    new InMemoryLogger(),
    HEARTBEAT_PATH,
    conversationManager,
    evaluators,
    messageInjector
  );
}

describe("HeartbeatScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let conversationManager: MockConversationManager;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-03-09T20:00:00Z"));
    conversationManager = new MockConversationManager();
  });

  describe("shouldRun", () => {
    it("always returns true", async () => {
      const scheduler = makeScheduler(fs, clock, conversationManager);
      expect(await scheduler.shouldRun()).toBe(true);
    });
  });

  describe("absent HEARTBEAT.md", () => {
    it("does not throw when HEARTBEAT.md is missing", async () => {
      const scheduler = makeScheduler(fs, clock, conversationManager);
      await expect(scheduler.run()).resolves.toBeUndefined();
      expect(conversationManager.appendedEntries).toHaveLength(0);
    });
  });

  describe("@once entries", () => {
    it("fires @once entry immediately and removes it", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nFirst boot task.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("[HEARTBEAT");
      expect(conversationManager.appendedEntries[0].entry).toContain("First boot task.");

      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining.trim()).toBe("");
    });

    it("removes only fired @once entries, keeps others", async () => {
      const content = `# @once\nOne-shot entry.\n\n# 30 * * * *\nRecurring entry.\n`;
      await fs.writeFile(HEARTBEAT_PATH, content);
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining).toContain("Recurring entry.");
      expect(remaining).not.toContain("One-shot entry.");
    });

    it("fires multiple @once entries in one run", async () => {
      const content = `# @once\nFirst task.\n\n# @once\nSecond task.\n`;
      await fs.writeFile(HEARTBEAT_PATH, content);
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(2);
      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining.trim()).toBe("");
    });
  });

  describe("ISO timestamp entries", () => {
    it("fires ISO entry at exact time and removes it", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# 2026-03-09T20:00Z\nCheck FP9.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("Check FP9.");
      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining.trim()).toBe("");
    });

    it("fires ISO entry that is in the past", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# 2026-03-01T00:00Z\nPast entry.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("does not fire ISO entry that is in the future", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# 2026-03-10T00:00Z\nFuture entry.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(0);
      // Entry should still be in file
      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining).toContain("Future entry.");
    });
  });

  describe("cron entries", () => {
    it("fires cron entry when expression matches current time", async () => {
      // Clock is 2026-03-09T20:00:00Z — minute=0, hour=20
      await fs.writeFile(HEARTBEAT_PATH, "# 0 20 * * *\nDaily at 20:00.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("does not fire cron entry when expression does not match", async () => {
      // Clock is minute=0, but cron expects minute=30
      await fs.writeFile(HEARTBEAT_PATH, "# 30 20 * * *\nAt 20:30.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(0);
    });

    it("does not fire cron entry twice in the same minute", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# * * * * *\nEvery minute.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run(); // First run — fires
      await scheduler.run(); // Second run in same minute — should not fire

      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("fires cron entry again after minute advances", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# * * * * *\nEvery minute.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run(); // First minute — fires
      clock.advance(60000); // Advance 1 minute
      await scheduler.run(); // Second minute — fires again

      expect(conversationManager.appendedEntries).toHaveLength(2);
    });

    it("keeps cron entry in file after firing", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# 0 20 * * *\nDaily.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      const remaining = await fs.readFile(HEARTBEAT_PATH);
      expect(remaining).toContain("Daily.");
    });
  });

  describe("condition-only entries (when:)", () => {
    it("fires condition-only entry when condition is met (edge trigger)", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# when: test_condition\nCondition fired.\n");

      let conditionValue = false;
      const testEvaluator: IConditionEvaluator = {
        evaluate: async () => conditionValue,
      };
      const evaluators = new Map<string, IConditionEvaluator>([
        ["test_condition", testEvaluator],
      ]);
      const scheduler = makeScheduler(fs, clock, conversationManager, evaluators);

      await scheduler.run(); // Condition false — no fire
      expect(conversationManager.appendedEntries).toHaveLength(0);

      conditionValue = true;
      await scheduler.run(); // false→true — fires
      expect(conversationManager.appendedEntries).toHaveLength(1);

      await scheduler.run(); // still true — edge already fired, no re-fire
      expect(conversationManager.appendedEntries).toHaveLength(1);

      conditionValue = false;
      await scheduler.run(); // true→false — no fire
      expect(conversationManager.appendedEntries).toHaveLength(1);

      conditionValue = true;
      await scheduler.run(); // false→true again — fires again
      expect(conversationManager.appendedEntries).toHaveLength(2);
    });

    it("does not fire for unknown condition evaluator", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# when: unknown_condition\nShould not fire.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager, new Map());

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(0);
    });
  });

  describe("schedule + condition entries", () => {
    it("fires only when both time and condition are met", async () => {
      // Clock is 2026-03-09T20:00Z — ISO time is met
      await fs.writeFile(
        HEARTBEAT_PATH,
        "# 2026-03-09T20:00Z when: test_cond\nTime + condition.\n"
      );

      let conditionValue = false;
      const evaluators = new Map<string, IConditionEvaluator>([
        ["test_cond", { evaluate: async () => conditionValue }],
      ]);
      const scheduler = makeScheduler(fs, clock, conversationManager, evaluators);

      await scheduler.run(); // Time met but condition false — no fire
      expect(conversationManager.appendedEntries).toHaveLength(0);

      conditionValue = true;
      await scheduler.run(); // Time met and condition true — fires
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });
  });

  describe("CONVERSATION.md format", () => {
    it("writes [HEARTBEAT <iso>] prefix", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nTest payload.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      const entry = conversationManager.appendedEntries[0].entry;
      expect(entry).toMatch(/^\[HEARTBEAT 2026-03-09T20:00:00\.000Z\] Test payload\.$/);
    });

    it("collapses multi-line payload to single line", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nLine one.\nLine two.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      const entry = conversationManager.appendedEntries[0].entry;
      expect(entry).not.toContain("\n");
      expect(entry).toContain("Line one.");
      expect(entry).toContain("Line two.");
    });
  });

  describe("message injection", () => {
    it("injects fired entries into messageInjector when provided", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nDo the thing.\n");
      const injector = new MockMessageInjector();
      const scheduler = makeScheduler(fs, clock, conversationManager, undefined, injector);

      await scheduler.run();

      expect(injector.injectedMessages).toHaveLength(1);
      expect(injector.injectedMessages[0]).toContain("[HEARTBEAT");
      expect(injector.injectedMessages[0]).toContain("Do the thing.");
    });

    it("injects cron entries so cycles process them", async () => {
      // Clock is 2026-03-09T20:00:00Z — minute=0, hour=20
      await fs.writeFile(HEARTBEAT_PATH, "# 0 20 * * *\nHourly task.\n");
      const injector = new MockMessageInjector();
      const scheduler = makeScheduler(fs, clock, conversationManager, undefined, injector);

      await scheduler.run();

      expect(injector.injectedMessages).toHaveLength(1);
      expect(injector.injectedMessages[0]).toContain("Hourly task.");
      // Also appended to conversation for persistence
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("works without messageInjector (backwards compatible)", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nPayload.\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await scheduler.run();

      expect(conversationManager.appendedEntries).toHaveLength(1);
    });
  });

  describe("graceful error handling", () => {
    it("handles malformed HEARTBEAT.md without crashing", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "not a valid heartbeat file\njust random text\n");
      const scheduler = makeScheduler(fs, clock, conversationManager);

      await expect(scheduler.run()).resolves.toBeUndefined();
      // Malformed content has no valid entries (no # headers) → no fires
      expect(conversationManager.appendedEntries).toHaveLength(0);
    });

    it("handles conversation manager error gracefully", async () => {
      await fs.writeFile(HEARTBEAT_PATH, "# @once\nPayload.\n");
      const errorManager: IConversationManager = {
        append: async () => { throw new Error("write failed"); },
      };
      const scheduler = new HeartbeatScheduler(
        fs, clock, new InMemoryLogger(), HEARTBEAT_PATH, errorManager
      );

      await expect(scheduler.run()).resolves.toBeUndefined();
    });
  });
});

describe("AgoraPeerMessageCondition", () => {
  it("returns false when no message received", async () => {
    const condition = new AgoraPeerMessageCondition();
    expect(await condition.evaluate("agora_peer_message")).toBe(false);
  });

  it("returns true once after notifyMessage", async () => {
    const condition = new AgoraPeerMessageCondition();
    condition.notifyMessage();
    expect(await condition.evaluate("agora_peer_message")).toBe(true);
  });

  it("resets after evaluate returns true", async () => {
    const condition = new AgoraPeerMessageCondition();
    condition.notifyMessage();
    await condition.evaluate("agora_peer_message"); // consume
    expect(await condition.evaluate("agora_peer_message")).toBe(false);
  });

  it("re-arms after another notifyMessage", async () => {
    const condition = new AgoraPeerMessageCondition();
    condition.notifyMessage();
    await condition.evaluate("agora_peer_message"); // consume
    condition.notifyMessage(); // new message
    expect(await condition.evaluate("agora_peer_message")).toBe(true);
  });

  it("fires once per message via HeartbeatScheduler edge trigger", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-03-09T20:00:00Z"));
    const conversationManager = new MockConversationManager();

    const condition = new AgoraPeerMessageCondition();
    const evaluators = new Map<string, IConditionEvaluator>([
      [AgoraPeerMessageCondition.PREFIX, condition],
    ]);
    await fs.writeFile(HEARTBEAT_PATH, "# when: agora_peer_message\nNew message arrived.\n");
    const scheduler = makeScheduler(fs, clock, conversationManager, evaluators);

    // No message yet
    await scheduler.run();
    expect(conversationManager.appendedEntries).toHaveLength(0);

    // Message arrives
    condition.notifyMessage();
    await scheduler.run();
    expect(conversationManager.appendedEntries).toHaveLength(1);

    // No more messages — edge trigger should NOT re-fire
    await scheduler.run();
    expect(conversationManager.appendedEntries).toHaveLength(1);

    // Second message arrives
    condition.notifyMessage();
    await scheduler.run();
    expect(conversationManager.appendedEntries).toHaveLength(2);
  });
});

describe("PeerAvailabilityCondition", () => {
  const peerConfig = [{ peerId: "nova", apiStatusUrl: "http://nova/api/loop/status" }];

  function makeFetch(available: boolean, rateLimitUntil: string | null = null) {
    return async (_url: string) => ({
      ok: true,
      json: async () => ({
        state: available ? "RUNNING" : "RATE_LIMITED",
        rateLimitUntil,
        online: true,
      }),
    });
  }

  function makeOfflineFetch() {
    return async (_url: string): Promise<never> => {
      throw new Error("Connection refused");
    };
  }

  it("returns false when peer starts available (no prior offline state)", async () => {
    const fetch = makeFetch(true);
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);
    // First call: lastAvailable=undefined(false), now available → true (offline→online transition)
    expect(await condition.evaluate("peer:nova.available")).toBe(true);
  });

  it("returns false on second call when peer stays available (no new edge)", async () => {
    const fetch = makeFetch(true);
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);
    await condition.evaluate("peer:nova.available"); // first: fires (false→true)
    expect(await condition.evaluate("peer:nova.available")).toBe(false); // still available: no edge
  });

  it("re-fires when peer goes offline then comes back online", async () => {
    let available = true;
    const fetch = async (_url: string) => ({
      ok: true,
      json: async () => ({
        state: available ? "RUNNING" : "RATE_LIMITED",
        rateLimitUntil: available ? null : "2099-01-01T00:00:00Z",
        online: true,
      }),
    });
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);

    // Initial: offline→online transition
    await condition.evaluate("peer:nova.available"); // fires
    // Goes offline
    available = false;
    await condition.evaluate("peer:nova.available"); // offline: no fire
    // Comes back online
    available = true;
    const fired = await condition.evaluate("peer:nova.available");
    expect(fired).toBe(true);
  });

  it("returns false when peer is rate-limited", async () => {
    const fetch = makeFetch(true, "2099-01-01T00:00:00Z"); // future rate limit
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);
    // lastAvailable starts as false. Rate-limited peer is not available.
    // false→false: no transition
    expect(await condition.evaluate("peer:nova.available")).toBe(false);
  });

  it("returns false for unknown peer", async () => {
    const fetch = makeFetch(true);
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);
    expect(await condition.evaluate("peer:unknown.available")).toBe(false);
  });

  it("returns false when peer endpoint throws", async () => {
    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), makeOfflineFetch());
    // lastAvailable=false, now also false (offline→offline): no fire
    expect(await condition.evaluate("peer:nova.available")).toBe(false);
  });

  it("fires via HeartbeatScheduler when peer comes online", async () => {
    const fsInst = new InMemoryFileSystem();
    const clockInst = new FixedClock(new Date("2026-03-09T20:00:00Z"));
    const cmgr = new MockConversationManager();

    let peerOnline = false;
    const fetch = async (_url: string) => ({
      ok: peerOnline,
      json: async () => ({ state: "RUNNING", rateLimitUntil: null, online: peerOnline }),
    });

    const condition = new PeerAvailabilityCondition(peerConfig, new InMemoryLogger(), fetch);
    const evaluators = new Map<string, IConditionEvaluator>([
      [PeerAvailabilityCondition.PREFIX, condition],
    ]);
    await fsInst.writeFile(HEARTBEAT_PATH, "# when: peer:nova.available\nNova is back.\n");
    const scheduler = makeScheduler(fsInst, clockInst, cmgr, evaluators);

    await scheduler.run(); // peer offline — no fire
    expect(cmgr.appendedEntries).toHaveLength(0);

    peerOnline = true;
    await scheduler.run(); // peer online → edge fires
    expect(cmgr.appendedEntries).toHaveLength(1);
    expect(cmgr.appendedEntries[0].entry).toContain("Nova is back.");

    await scheduler.run(); // still online — no re-fire
    expect(cmgr.appendedEntries).toHaveLength(1);
  });
});
