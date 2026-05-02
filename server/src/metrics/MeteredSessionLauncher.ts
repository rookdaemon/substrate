import type {
  ClaudeSessionRequest,
  ClaudeSessionResult,
  ISessionLauncher,
  LaunchOptions,
} from "../agents/claude/ISessionLauncher";
import type { IClock } from "../substrate/abstractions/IClock";
import type { IMetricsService } from "./IMetricsService";
import { BudgetGuard } from "../budget/BudgetGuard";

export class MeteredSessionLauncher implements ISessionLauncher {
  constructor(
    private readonly inner: ISessionLauncher,
    private readonly metrics: IMetricsService,
    private readonly clock: IClock,
    private readonly budgetGuard?: BudgetGuard,
    private readonly defaultProvider?: ClaudeSessionResult["usage"]["provider"],
    private readonly defaultModel?: string,
  ) {}

  async launch(request: ClaudeSessionRequest, options?: LaunchOptions): Promise<ClaudeSessionResult> {
    const started = this.clock.now();
    const role = options?.usageContext?.role;
    const operation = options?.usageContext?.operation;
    await this.budgetGuard?.preflight({
      provider: this.defaultProvider ?? "deterministic",
      model: options?.model ?? this.defaultModel,
      role,
      operation,
      estimatedPromptTokens: estimateTokens(request.systemPrompt) + estimateTokens(request.message),
    });
    const result = await this.inner.launch(request, options);
    const completed = new Date(started.getTime() + result.durationMs);
    await this.budgetGuard?.recordPostCall({
      provider: result.usage?.provider ?? this.defaultProvider ?? "deterministic",
      model: result.usage?.model ?? options?.model ?? this.defaultModel,
      role,
      operation,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      success: result.success,
      durationMs: result.durationMs,
      usage: result.usage,
    });
    if (result.usage) {
      await this.metrics.recordLlmSession({
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        role,
        operation,
        provider: result.usage.provider,
        model: result.usage.model,
        promptTokens: result.usage.promptTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        nonCachedInputTokens: result.usage.nonCachedInputTokens,
        completionTokens: result.usage.completionTokens,
        reasoningOutputTokens: result.usage.reasoningOutputTokens,
        totalTokens: result.usage.totalTokens,
        costUsd: result.usage.costUsd,
        costKnown: result.usage.costKnown,
        costEstimate: result.usage.costEstimate,
        billingSource: result.usage.billingSource,
        telemetrySource: result.usage.telemetrySource,
        success: result.success,
        durationMs: result.durationMs,
      });
    }
    return result;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
