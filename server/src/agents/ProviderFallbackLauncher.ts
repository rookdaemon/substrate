import type { ILogger } from "../logging";
import type {
  ClaudeSessionRequest,
  ClaudeSessionResult,
  ISessionLauncher,
  LaunchOptions,
  SessionUsage,
} from "./claude/ISessionLauncher";
import { isFrontierModel } from "./SurvivalModelPolicyLauncher";

export type ProviderFailureKind = "auth" | "rate_limit" | "provider" | "model" | "tool" | "unknown";

export interface ProviderFailureClassification {
  kind: ProviderFailureKind;
  retryable: boolean;
  degradedRouteAllowed: boolean;
  reason: string;
}

export interface ProviderFallbackRoute {
  provider: SessionUsage["provider"];
  model?: string;
  launcher: ISessionLauncher;
}

export class UnsafeProviderFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeProviderFallbackError";
  }
}

export class ProviderFallbackLauncher implements ISessionLauncher {
  constructor(
    private readonly primary: ISessionLauncher,
    private readonly fallbackRoutes: ProviderFallbackRoute[],
    private readonly logger?: ILogger,
  ) {}

  async launch(request: ClaudeSessionRequest, options?: LaunchOptions): Promise<ClaudeSessionResult> {
    const primary = await this.primary.launch(request, options);
    if (primary.success) return primary;

    const classification = classifyProviderFailure(primary);
    if (!classification.degradedRouteAllowed) {
      this.logger?.warn(`provider-fallback: no degraded route for ${classification.kind}: ${classification.reason}`);
      return primary;
    }

    for (const route of this.fallbackRoutes) {
      try {
        assertApprovedProviderFallback(route.provider, route.model);
      } catch (err) {
        this.logger?.warn(`provider-fallback: blocked unsafe route ${route.provider}/${route.model ?? "default"}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      this.logger?.warn(`provider-fallback: ${classification.kind} failure; trying ${route.provider}/${route.model ?? "default"}`);
      const fallback = await route.launcher.launch(request, {
        ...options,
        model: route.model,
        allowFrontierModel: false,
      });
      if (fallback.success) return fallback;
    }

    return {
      ...primary,
      error: `${primary.error ?? "primary provider failed"}; no approved degraded provider fallback succeeded`,
    };
  }
}

export class UnavailableProviderLauncher implements ISessionLauncher {
  constructor(
    private readonly provider: SessionUsage["provider"],
    private readonly reason: string,
  ) {}

  async launch(_request: ClaudeSessionRequest, _options?: LaunchOptions): Promise<ClaudeSessionResult> {
    return {
      rawOutput: "",
      exitCode: 1,
      durationMs: 0,
      success: false,
      error: `${this.provider} provider unavailable: ${this.reason}`,
    };
  }
}

export function classifyProviderFailure(result: ClaudeSessionResult | Error | string): ProviderFailureClassification {
  const text = providerFailureText(result);
  const lower = text.toLowerCase();

  if (/(unauthorized|forbidden|invalid api key|api key not configured|access token not configured|authentication|permission denied|401|403)/.test(lower)) {
    return classification("auth", false, true, text);
  }
  if (/(rate limit|rate-limit|too many requests|quota|exhausted|429)/.test(lower)) {
    return classification("rate_limit", true, true, text);
  }
  if (/(model .*not found|model not found|invalid model|unsupported model|unknown model|404)/.test(lower)) {
    return classification("model", false, true, text);
  }
  if (/(tool_use|tool_result|mcp|tool call|tool failed|no such tool|tool error)/.test(lower)) {
    return classification("tool", false, true, text);
  }
  if (/(fetch failed|econnrefused|network|timeout|timed out|service unavailable|bad gateway|gateway timeout|503|502|504|provider|cannot reach)/.test(lower)) {
    return classification("provider", true, true, text);
  }

  return classification("unknown", false, false, text);
}

export function assertApprovedProviderFallback(provider: SessionUsage["provider"], model: string | undefined): void {
  if (isFrontierModel(model)) {
    throw new UnsafeProviderFallbackError(`frontier model ${model} is not an approved degraded fallback`);
  }
  if (!isApprovedDegradedProviderModel(provider, model)) {
    throw new UnsafeProviderFallbackError(`unknown-cost or expensive fallback ${provider}/${model ?? "default"} is not approved`);
  }
}

export function isApprovedDegradedProviderModel(provider: SessionUsage["provider"], model: string | undefined): boolean {
  if (provider === "deterministic") return true;
  if (provider === "ollama") return true;
  if (!model) return false;

  const approved: Partial<Record<SessionUsage["provider"], Set<string>>> = {
    codex: new Set(["gpt-5.4-mini"]),
    claude: new Set(["claude-haiku-4-5"]),
    anthropic: new Set(["claude-haiku-4-20250514"]),
    gemini: new Set(["gemini-2.5-flash"]),
    vertex: new Set(["gemini-2.5-flash"]),
    groq: new Set(["llama-3.1-8b-instant", "llama3-8b-8192"]),
  };
  return approved[provider]?.has(model) ?? false;
}

function classification(
  kind: ProviderFailureKind,
  retryable: boolean,
  degradedRouteAllowed: boolean,
  reason: string,
): ProviderFailureClassification {
  return {
    kind,
    retryable,
    degradedRouteAllowed,
    reason: reason || kind,
  };
}

function providerFailureText(result: ClaudeSessionResult | Error | string): string {
  if (typeof result === "string") return result;
  if (result instanceof Error) return result.message;
  return result.error || result.rawOutput || `exitCode=${result.exitCode}`;
}
