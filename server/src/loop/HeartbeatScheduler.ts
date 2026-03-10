import type { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { IClock } from "../substrate/abstractions/IClock";
import type { ILogger } from "../logging";
import type { IConversationManager } from "../conversation/IConversationManager";
import type { IConditionEvaluator } from "./IConditionEvaluator";
import { AgentRole } from "../agents/types";
import {
  parseHeartbeat,
  serialiseHeartbeat,
  detectScheduleType,
  matchesCron,
  sameUtcMinute,
  entryKey,
  type HeartbeatEntry,
} from "./HeartbeatParser";

/**
 * HeartbeatScheduler — reads HEARTBEAT.md each cycle, fires due entries, and
 * removes one-shot entries (ISO timestamps, @once) after they fire.
 *
 * Injected into CONVERSATION.md as: `[HEARTBEAT <iso>] <payload>`
 *
 * Schedule types:
 *   @once              — fires immediately once, then removed
 *   ISO timestamp      — fires at/after the specified UTC time, then removed
 *   5-field cron       — fires every matching minute (UTC), persists
 *   condition-only     — no time schedule; fires on condition edge trigger
 *   schedule+condition — time schedule gates polling; condition gates firing
 */
export class HeartbeatScheduler {
  /** Last UTC minute each cron entry fired (keyed by entryKey). */
  private readonly lastCronFired = new Map<string, Date>();
  /** Last condition result per entry for edge-trigger tracking. */
  private readonly lastConditionResult = new Map<string, boolean>();

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly heartbeatPath: string,
    private readonly conversationManager: IConversationManager,
    private readonly evaluators: Map<string, IConditionEvaluator> = new Map()
  ) {}

  async shouldRun(): Promise<boolean> {
    return true; // Always check; time/condition logic is inside run()
  }

  async run(): Promise<void> {
    let content: string;
    try {
      content = await this.fs.readFile(this.heartbeatPath);
    } catch {
      return; // HEARTBEAT.md absent — graceful no-op
    }

    const entries = parseHeartbeat(content);
    if (entries.length === 0) return;

    const now = this.clock.now();
    const surviving: HeartbeatEntry[] = [];
    let anyShotFired = false;

    for (const entry of entries) {
      const fired = await this.processEntry(entry, now);
      const type = detectScheduleType(entry.schedule);
      const isOneShot = type === "once" || type === "iso";
      if (fired && isOneShot) {
        anyShotFired = true;
        // One-shot entries are dropped after firing
      } else {
        surviving.push(entry);
      }
    }

    if (anyShotFired) {
      try {
        await this.fs.writeFile(this.heartbeatPath, serialiseHeartbeat(surviving));
        this.logger.debug(
          `[HEARTBEAT] Removed ${entries.length - surviving.length} one-shot entries from HEARTBEAT.md`
        );
      } catch (err) {
        this.logger.debug(
          `[HEARTBEAT] Failed to rewrite HEARTBEAT.md: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Evaluate a single entry. Returns true if the entry fired this cycle.
   */
  private async processEntry(entry: HeartbeatEntry, now: Date): Promise<boolean> {
    const type = detectScheduleType(entry.schedule);

    // --- Time-based gate ---
    let timeGatePassed: boolean;
    switch (type) {
      case "once":
        timeGatePassed = true;
        break;
      case "iso": {
        const target = new Date(entry.schedule);
        timeGatePassed = !isNaN(target.getTime()) && now >= target;
        break;
      }
      case "cron": {
        const key = entryKey(entry);
        const lastFired = this.lastCronFired.get(key);
        timeGatePassed =
          matchesCron(entry.schedule, now) &&
          (!lastFired || !sameUtcMinute(lastFired, now));
        break;
      }
      case "condition-only":
        timeGatePassed = true; // Condition is the sole gate
        break;
      default:
        this.logger.debug(`[HEARTBEAT] Skipping entry with unrecognised schedule: "${entry.schedule}"`);
        return false;
    }

    if (!timeGatePassed) return false;

    // --- Condition gate (edge-trigger) ---
    if (entry.condition) {
      const condMet = await this.evaluateCondition(entry.condition);
      const key = entryKey(entry);
      const prev = this.lastConditionResult.get(key) ?? false;
      this.lastConditionResult.set(key, condMet);

      // Fire only on false→true transition
      if (!(!prev && condMet)) return false;
    }

    // --- Fire ---
    const key = entryKey(entry);
    if (detectScheduleType(entry.schedule) === "cron") {
      this.lastCronFired.set(key, now);
    }
    await this.fireEntry(entry, now);
    return true;
  }

  private async evaluateCondition(condition: string): Promise<boolean> {
    // Support: "cond1 AND cond2"
    const parts = condition.split(/\s+AND\s+/i);
    for (const part of parts) {
      if (!(await this.evaluateSingleCondition(part.trim()))) return false;
    }
    return true;
  }

  private async evaluateSingleCondition(condition: string): Promise<boolean> {
    for (const [prefix, evaluator] of this.evaluators) {
      if (condition === prefix || condition.startsWith(prefix)) {
        try {
          return await evaluator.evaluate(condition);
        } catch (err) {
          this.logger.debug(
            `[HEARTBEAT] Condition evaluator error for "${condition}": ${err instanceof Error ? err.message : String(err)}`
          );
          return false;
        }
      }
    }
    this.logger.debug(`[HEARTBEAT] No evaluator registered for condition: "${condition}"`);
    return false;
  }

  private async fireEntry(entry: HeartbeatEntry, now: Date): Promise<void> {
    const iso = now.toISOString();
    // Collapse multi-line payload to single line for the conversation entry
    const text = entry.payload.replace(/\s+/g, " ").trim();
    const message = `[HEARTBEAT ${iso}] ${text}`;
    this.logger.debug(`[HEARTBEAT] Firing: ${message.slice(0, 100)}`);
    try {
      await this.conversationManager.append(AgentRole.SUBCONSCIOUS, message);
    } catch (err) {
      this.logger.debug(
        `[HEARTBEAT] Failed to append to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
