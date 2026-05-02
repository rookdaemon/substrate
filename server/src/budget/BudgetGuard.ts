import * as crypto from "node:crypto";
import * as path from "node:path";
import type { SessionUsage } from "../agents/claude/ISessionLauncher";
import type { ILogger } from "../logging";
import type { IClock } from "../substrate/abstractions/IClock";
import type { IFileSystem } from "../substrate/abstractions/IFileSystem";

export type BudgetThreshold = 0 | 75 | 90 | 100;

export interface BudgetGuardConfig {
  monthlyBudgetUsd: number;
  warnThresholdPercent: number;
  hardWarnThresholdPercent: number;
  killThresholdPercent: number;
  defaultUnknownEstimateUsd: number;
}

export interface BudgetPreflightRequest {
  provider: SessionUsage["provider"];
  model?: string;
  role?: string;
  operation?: string;
  estimatedPromptTokens?: number;
  estimatedCompletionTokens?: number;
}

export interface BudgetPostCallRequest extends BudgetPreflightRequest {
  startedAt: string;
  completedAt: string;
  success: boolean;
  durationMs: number;
  usage?: SessionUsage;
}

export interface SpendLedgerRecord {
  version: 1;
  id: string;
  sequence: number;
  timestamp: string;
  eventType: "preflight_estimate" | "post_call_usage" | "preflight_blocked" | "threshold_crossed";
  provider: SessionUsage["provider"];
  model?: string;
  role?: string;
  operation?: string;
  amountUsd: number;
  amountKind: "estimate" | "actual" | "default_estimate";
  costKnown: boolean;
  billingSource: SessionUsage["billingSource"];
  telemetrySource: string;
  promptTokens?: number;
  cachedInputTokens?: number;
  nonCachedInputTokens?: number;
  completionTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  success?: boolean;
  durationMs?: number;
  thresholdPercent?: BudgetThreshold;
  monthlyBudgetUsd: number;
  month: string;
  counted: boolean;
  previousHash: string;
  hash: string;
}

export interface BudgetMonthlySummary {
  month: string;
  monthlyBudgetUsd: number;
  spentUsd: number;
  estimatedUsd: number;
  knownUsd: number;
  sessions: number;
  thresholdPercent: BudgetThreshold;
  remainingUsd: number;
}

export interface BudgetThresholdState extends BudgetMonthlySummary {
  updatedAt: string;
  hibernateRequested: boolean;
  stefanAlertRequired: boolean;
  lastAlertedThresholdPercent: BudgetThreshold;
}

export interface BudgetGuardHooks {
  onThresholdCrossed?(state: BudgetThresholdState, record: SpendLedgerRecord): Promise<void> | void;
  onBudgetExhausted?(state: BudgetThresholdState, record: SpendLedgerRecord): Promise<void> | void;
}

export class BudgetGuardError extends Error {
  constructor(
    message: string,
    readonly state: BudgetThresholdState,
  ) {
    super(message);
    this.name = "BudgetGuardError";
  }
}

const ZERO_HASH = "0".repeat(64);

export const DEFAULT_BUDGET_GUARD_CONFIG: BudgetGuardConfig = {
  monthlyBudgetUsd: 30,
  warnThresholdPercent: 75,
  hardWarnThresholdPercent: 90,
  killThresholdPercent: 100,
  defaultUnknownEstimateUsd: 1,
};

export class SpendLedger {
  constructor(
    private readonly fs: IFileSystem,
    private readonly ledgerPath: string,
  ) {}

  static forSubstratePath(substratePath: string, fs: IFileSystem): SpendLedger {
    return new SpendLedger(fs, path.join(substratePath, ".metrics", "spend-ledger.jsonl"));
  }

  async append(record: Omit<SpendLedgerRecord, "sequence" | "previousHash" | "hash">): Promise<SpendLedgerRecord> {
    await this.fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const records = await this.readRecords();
    const previous = records.at(-1);
    const complete = {
      ...record,
      sequence: records.length + 1,
      previousHash: previous?.hash ?? ZERO_HASH,
    } as Omit<SpendLedgerRecord, "hash">;
    const hash = hashRecord(complete);
    const line: SpendLedgerRecord = { ...complete, hash };
    await this.fs.appendFile(this.ledgerPath, `${JSON.stringify(line)}\n`);
    return line;
  }

  async readRecords(): Promise<SpendLedgerRecord[]> {
    if (!(await this.fs.exists(this.ledgerPath))) return [];
    const raw = await this.fs.readFile(this.ledgerPath);
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SpendLedgerRecord);
  }

  async verifyHashChain(): Promise<boolean> {
    const records = await this.readRecords();
    let previousHash = ZERO_HASH;
    for (let i = 0; i < records.length; i++) {
      const { hash, ...withoutHash } = records[i];
      if (records[i].sequence !== i + 1 || records[i].previousHash !== previousHash) return false;
      if (hashRecord(withoutHash) !== hash) return false;
      previousHash = hash;
    }
    return true;
  }
}

export class BudgetGuard {
  constructor(
    private readonly ledger: SpendLedger,
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly statePath: string,
    private readonly alertPath: string,
    private readonly config: BudgetGuardConfig = DEFAULT_BUDGET_GUARD_CONFIG,
    private readonly logger?: ILogger,
    private readonly hooks: BudgetGuardHooks = {},
  ) {}

  static forSubstratePath(
    substratePath: string,
    fs: IFileSystem,
    clock: IClock,
    logger?: ILogger,
    config: Partial<BudgetGuardConfig> = {},
    hooks: BudgetGuardHooks = {},
  ): BudgetGuard {
    const merged = { ...DEFAULT_BUDGET_GUARD_CONFIG, ...config };
    return new BudgetGuard(
      SpendLedger.forSubstratePath(substratePath, fs),
      fs,
      clock,
      path.join(substratePath, ".metrics", "budgetguard-state.json"),
      path.join(substratePath, ".metrics", "budgetguard-alerts.jsonl"),
      merged,
      logger,
      hooks,
    );
  }

  async preflight(request: BudgetPreflightRequest): Promise<SpendLedgerRecord> {
    const timestamp = this.clock.now().toISOString();
    const month = utcMonth(timestamp);
    const estimate = estimatePreflightCostUsd(request, this.config.defaultUnknownEstimateUsd);
    const summary = await this.summarizeMonth(month);
    const projected = summary.spentUsd + estimate.amountUsd;
    const projectedThreshold = thresholdFor(projected, this.config.monthlyBudgetUsd, this.config);

    if (projectedThreshold >= this.config.killThresholdPercent) {
      const blocked = await this.ledger.append(baseRecord({
        timestamp,
        eventType: "preflight_blocked",
        request,
        amountUsd: estimate.amountUsd,
        amountKind: estimate.amountKind,
        costKnown: false,
        billingSource: estimate.billingSource,
        telemetrySource: estimate.telemetrySource,
        monthlyBudgetUsd: this.config.monthlyBudgetUsd,
        month,
        counted: false,
        thresholdPercent: 100,
      }));
      const state = await this.writeState(month, 100, true);
      await this.emitAlert(state, blocked);
      await this.hooks.onBudgetExhausted?.(state, blocked);
      throw new BudgetGuardError(
        `BudgetGuard blocked dispatch: projected monthly spend ${projected.toFixed(6)} USD reaches ${this.config.killThresholdPercent}% of ${this.config.monthlyBudgetUsd} USD`,
        state,
      );
    }

    const record = await this.ledger.append(baseRecord({
      timestamp,
      eventType: "preflight_estimate",
      request,
      amountUsd: estimate.amountUsd,
      amountKind: estimate.amountKind,
      costKnown: false,
      billingSource: estimate.billingSource,
      telemetrySource: estimate.telemetrySource,
      monthlyBudgetUsd: this.config.monthlyBudgetUsd,
      month,
      counted: false,
      thresholdPercent: projectedThreshold,
    }));
    await this.updateThresholdState(month, projectedThreshold, record);
    return record;
  }

  async recordPostCall(request: BudgetPostCallRequest): Promise<SpendLedgerRecord> {
    const timestamp = request.completedAt || this.clock.now().toISOString();
    const month = utcMonth(timestamp);
    const usageCost = costFromUsage(request.usage, this.config.defaultUnknownEstimateUsd);
    const record = await this.ledger.append(baseRecord({
      timestamp,
      eventType: "post_call_usage",
      request,
      amountUsd: usageCost.amountUsd,
      amountKind: usageCost.amountKind,
      costKnown: request.usage?.costKnown ?? false,
      billingSource: usageCost.billingSource,
      telemetrySource: usageCost.telemetrySource,
      monthlyBudgetUsd: this.config.monthlyBudgetUsd,
      month,
      counted: true,
      success: request.success,
      durationMs: request.durationMs,
      thresholdPercent: 0,
    }));
    const summary = await this.summarizeMonth(month);
    const threshold = thresholdFor(summary.spentUsd, this.config.monthlyBudgetUsd, this.config);
    return this.updateThresholdState(month, threshold, record);
  }

  async summarizeCurrentMonth(): Promise<BudgetMonthlySummary> {
    return this.summarizeMonth(utcMonth(this.clock.now().toISOString()));
  }

  async summarizeMonth(month: string): Promise<BudgetMonthlySummary> {
    const records = await this.ledger.readRecords();
    let spentUsd = 0;
    let estimatedUsd = 0;
    let knownUsd = 0;
    let sessions = 0;
    for (const record of records) {
      if (record.month !== month || !record.counted) continue;
      spentUsd += record.amountUsd;
      sessions += 1;
      if (record.amountKind === "actual") {
        knownUsd += record.amountUsd;
      } else {
        estimatedUsd += record.amountUsd;
      }
    }
    return {
      month,
      monthlyBudgetUsd: this.config.monthlyBudgetUsd,
      spentUsd,
      estimatedUsd,
      knownUsd,
      sessions,
      thresholdPercent: thresholdFor(spentUsd, this.config.monthlyBudgetUsd, this.config),
      remainingUsd: Math.max(0, this.config.monthlyBudgetUsd - spentUsd),
    };
  }

  private async updateThresholdState(month: string, observedThreshold: BudgetThreshold, record: SpendLedgerRecord): Promise<SpendLedgerRecord> {
    const previous = await this.readState();
    const lastAlerted = previous?.month === month ? previous.lastAlertedThresholdPercent : 0;
    const state = await this.writeState(
      month,
      Math.max(observedThreshold, previous?.month === month ? previous.thresholdPercent : 0) as BudgetThreshold,
      observedThreshold >= this.config.killThresholdPercent || (previous?.month === month && previous.hibernateRequested),
      Math.max(lastAlerted, observedThreshold) as BudgetThreshold,
    );
    if (observedThreshold > lastAlerted && observedThreshold >= this.config.warnThresholdPercent) {
      const thresholdRecord = await this.ledger.append({
        ...baseRecord({
          timestamp: this.clock.now().toISOString(),
          eventType: "threshold_crossed",
          request: {
            provider: record.provider,
            model: record.model,
            role: record.role,
            operation: record.operation,
          },
          amountUsd: state.spentUsd,
          amountKind: "estimate",
          costKnown: false,
          billingSource: "unknown",
          telemetrySource: "budgetguard-threshold",
          monthlyBudgetUsd: this.config.monthlyBudgetUsd,
          month,
          counted: false,
          thresholdPercent: observedThreshold,
        }),
      });
      await this.emitAlert(state, thresholdRecord);
      await this.hooks.onThresholdCrossed?.(state, thresholdRecord);
      if (observedThreshold >= this.config.killThresholdPercent) {
        await this.hooks.onBudgetExhausted?.(state, thresholdRecord);
      }
    }
    return record;
  }

  private async readState(): Promise<BudgetThresholdState | null> {
    if (!(await this.fs.exists(this.statePath))) return null;
    return JSON.parse(await this.fs.readFile(this.statePath)) as BudgetThresholdState;
  }

  private async writeState(
    month: string,
    thresholdPercent: BudgetThreshold,
    hibernateRequested: boolean,
    lastAlertedThresholdPercent?: BudgetThreshold,
  ): Promise<BudgetThresholdState> {
    const summary = await this.summarizeMonth(month);
    const state: BudgetThresholdState = {
      ...summary,
      thresholdPercent,
      updatedAt: this.clock.now().toISOString(),
      hibernateRequested,
      stefanAlertRequired: thresholdPercent >= this.config.warnThresholdPercent,
      lastAlertedThresholdPercent: lastAlertedThresholdPercent ?? thresholdPercent,
    };
    await this.fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await this.fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  private async emitAlert(state: BudgetThresholdState, record: SpendLedgerRecord): Promise<void> {
    await this.fs.mkdir(path.dirname(this.alertPath), { recursive: true });
    await this.fs.appendFile(this.alertPath, `${JSON.stringify({
      timestamp: this.clock.now().toISOString(),
      month: state.month,
      thresholdPercent: state.thresholdPercent,
      spentUsd: state.spentUsd,
      monthlyBudgetUsd: state.monthlyBudgetUsd,
      hibernateRequested: state.hibernateRequested,
      stefanAlertRequired: true,
      ledgerRecordId: record.id,
      message: `BudgetGuard threshold ${state.thresholdPercent}% reached for ${state.month}: ${state.spentUsd.toFixed(6)} / ${state.monthlyBudgetUsd.toFixed(2)} USD`,
    })}\n`);
    this.logger?.warn(`BudgetGuard: threshold ${state.thresholdPercent}% reached; Stefan alert required`);
  }
}

function baseRecord(args: {
  timestamp: string;
  eventType: SpendLedgerRecord["eventType"];
  request: BudgetPreflightRequest;
  amountUsd: number;
  amountKind: SpendLedgerRecord["amountKind"];
  costKnown: boolean;
  billingSource: SessionUsage["billingSource"];
  telemetrySource: string;
  monthlyBudgetUsd: number;
  month: string;
  counted: boolean;
  success?: boolean;
  durationMs?: number;
  thresholdPercent?: BudgetThreshold;
}): Omit<SpendLedgerRecord, "sequence" | "previousHash" | "hash"> {
  return {
    version: 1,
    id: crypto.randomUUID(),
    timestamp: args.timestamp,
    eventType: args.eventType,
    provider: args.request.provider,
    ...(args.request.model ? { model: args.request.model } : {}),
    ...(args.request.role ? { role: args.request.role } : {}),
    ...(args.request.operation ? { operation: args.request.operation } : {}),
    amountUsd: args.amountUsd,
    amountKind: args.amountKind,
    costKnown: args.costKnown,
    billingSource: args.billingSource,
    telemetrySource: args.telemetrySource,
    ...(args.request.estimatedPromptTokens !== undefined ? { promptTokens: args.request.estimatedPromptTokens } : {}),
    ...(args.request.estimatedCompletionTokens !== undefined ? { completionTokens: args.request.estimatedCompletionTokens } : {}),
    ...(args.success !== undefined ? { success: args.success } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.thresholdPercent !== undefined ? { thresholdPercent: args.thresholdPercent } : {}),
    monthlyBudgetUsd: args.monthlyBudgetUsd,
    month: args.month,
    counted: args.counted,
  };
}

function costFromUsage(
  usage: SessionUsage | undefined,
  defaultUnknownEstimateUsd: number,
): { amountUsd: number; amountKind: SpendLedgerRecord["amountKind"]; billingSource: SessionUsage["billingSource"]; telemetrySource: string } {
  if (usage?.costUsd !== undefined) {
    return {
      amountUsd: usage.costUsd,
      amountKind: usage.costKnown ? "actual" : "estimate",
      billingSource: usage.billingSource,
      telemetrySource: usage.telemetrySource,
    };
  }
  return {
    amountUsd: defaultUnknownEstimateUsd,
    amountKind: "default_estimate",
    billingSource: usage?.billingSource ?? "unknown",
    telemetrySource: usage?.telemetrySource ?? "budgetguard-default-estimate",
  };
}

function estimatePreflightCostUsd(
  request: BudgetPreflightRequest,
  defaultUnknownEstimateUsd: number,
): { amountUsd: number; amountKind: SpendLedgerRecord["amountKind"]; billingSource: SessionUsage["billingSource"]; telemetrySource: string } {
  const rates = dollarRates(request.provider, request.model);
  if (!rates) {
    return {
      amountUsd: defaultUnknownEstimateUsd,
      amountKind: "default_estimate",
      billingSource: "unknown",
      telemetrySource: "budgetguard-default-estimate",
    };
  }
  const input = request.estimatedPromptTokens ?? 20_000;
  const output = request.estimatedCompletionTokens ?? 2_000;
  return {
    amountUsd: ((input * rates.inputUsdPerMillion) + (output * rates.outputUsdPerMillion)) / 1_000_000,
    amountKind: "estimate",
    billingSource: "static_estimate",
    telemetrySource: "budgetguard-static-estimate",
  };
}

function dollarRates(provider: SessionUsage["provider"], model: string | undefined): { inputUsdPerMillion: number; outputUsdPerMillion: number } | null {
  if (provider === "deterministic" || provider === "ollama") return { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  switch (model) {
    case "gpt-5.5":
      return { inputUsdPerMillion: 5, outputUsdPerMillion: 30 };
    case "gpt-5.4":
      return { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 };
    case "gpt-5.4-mini":
      return { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 };
    case "claude-opus-4-6":
      return { inputUsdPerMillion: 15, outputUsdPerMillion: 75 };
    case "claude-haiku-4-5":
    case "claude-haiku-4-20250514":
      return { inputUsdPerMillion: 1, outputUsdPerMillion: 5 };
    case "claude-sonnet-4-6":
    case "claude-sonnet-4-20250514":
      return { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    case "gemini-2.5-flash":
      return { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 };
    case "llama-3.1-8b-instant":
    case "llama3-8b-8192":
      return { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.08 };
    default:
      return null;
  }
}

function thresholdFor(spentUsd: number, monthlyBudgetUsd: number, config: BudgetGuardConfig): BudgetThreshold {
  const pct = monthlyBudgetUsd > 0 ? (spentUsd / monthlyBudgetUsd) * 100 : 100;
  if (pct >= config.killThresholdPercent) return 100;
  if (pct >= config.hardWarnThresholdPercent) return 90;
  if (pct >= config.warnThresholdPercent) return 75;
  return 0;
}

function utcMonth(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 7);
}

function hashRecord(record: Omit<SpendLedgerRecord, "hash">): string {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
