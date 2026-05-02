import type { ILogger } from "../logging";
import type {
  ClaudeSessionRequest,
  ClaudeSessionResult,
  ISessionLauncher,
  LaunchOptions,
  SessionUsage,
} from "./claude/ISessionLauncher";

export interface SurvivalModelPolicyConfig {
  provider: SessionUsage["provider"];
  defaultModel?: string;
  lowCostModel?: string;
  nonFrontierModel?: string;
}

const FRONTIER_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-20250514",
]);

const LOW_COST_BY_PROVIDER: Partial<Record<SessionUsage["provider"], string>> = {
  codex: "gpt-5.4-mini",
  claude: "claude-haiku-4-5",
  anthropic: "claude-haiku-4-20250514",
  gemini: "gemini-2.5-flash",
  vertex: "gemini-2.5-flash",
  groq: "llama-3.1-8b-instant",
};

const NON_FRONTIER_BY_PROVIDER: Partial<Record<SessionUsage["provider"], string>> = {
  codex: "gpt-5.4-mini",
  claude: "claude-sonnet-4-6",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
  vertex: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
};

/**
 * Survival-mode model policy for cognitive dispatch.
 *
 * It keeps routine/default dispatch on low-cost models, routes Subconscious to
 * a non-frontier model by default, and prevents frontier models from being used
 * unless the caller sets allowFrontierModel on the launch options.
 */
export class SurvivalModelPolicyLauncher implements ISessionLauncher {
  constructor(
    private readonly inner: ISessionLauncher,
    private readonly config: SurvivalModelPolicyConfig,
    private readonly logger?: ILogger,
  ) {}

  async launch(request: ClaudeSessionRequest, options?: LaunchOptions): Promise<ClaudeSessionResult> {
    const resolved = this.resolveOptions(options);
    return this.inner.launch(request, resolved);
  }

  private resolveOptions(options?: LaunchOptions): LaunchOptions | undefined {
    const requestedModel = options?.model ?? this.config.defaultModel;
    const role = options?.usageContext?.role;
    const replacement = this.replacementModelFor(requestedModel, role, options?.allowFrontierModel === true);
    if (!replacement && options?.model === requestedModel) return options;

    return {
      ...options,
      model: replacement ?? requestedModel,
    };
  }

  private replacementModelFor(
    requestedModel: string | undefined,
    role: string | undefined,
    allowFrontierModel: boolean,
  ): string | undefined {
    if (!requestedModel) return this.config.lowCostModel ?? LOW_COST_BY_PROVIDER[this.config.provider];

    if (isIncompatibleProviderModel(this.config.provider, requestedModel)) {
      const replacement = this.config.lowCostModel ?? LOW_COST_BY_PROVIDER[this.config.provider];
      this.logger?.warn(`survival-model-policy: replaced incompatible ${this.config.provider} model ${requestedModel} with ${replacement ?? "provider default"}`);
      return replacement;
    }

    if (role === "SUBCONSCIOUS" && isFrontierModel(requestedModel) && !allowFrontierModel) {
      const replacement = this.config.nonFrontierModel ?? NON_FRONTIER_BY_PROVIDER[this.config.provider] ?? LOW_COST_BY_PROVIDER[this.config.provider];
      this.logger?.warn(`survival-model-policy: downgraded SUBCONSCIOUS model ${requestedModel} to ${replacement ?? "provider default"}`);
      return replacement;
    }

    if (isFrontierModel(requestedModel) && !allowFrontierModel) {
      const replacement = this.config.lowCostModel ?? LOW_COST_BY_PROVIDER[this.config.provider];
      this.logger?.warn(`survival-model-policy: downgraded frontier model ${requestedModel} to ${replacement ?? "provider default"} without explicit opt-in`);
      return replacement;
    }

    return requestedModel;
  }
}

export function isFrontierModel(model: string | undefined): boolean {
  if (!model) return false;
  return FRONTIER_MODELS.has(model) || model.includes("opus") || model === "gpt-5.5";
}

function isIncompatibleProviderModel(provider: SessionUsage["provider"], model: string): boolean {
  if (provider === "codex") return model.startsWith("claude-") || model.startsWith("gemini-") || model.startsWith("gemma-");
  if (provider === "claude" || provider === "anthropic") return model.startsWith("gpt-") || model.startsWith("gemini-") || model.startsWith("gemma-");
  if (provider === "gemini" || provider === "vertex") return model.startsWith("gpt-") || model.startsWith("claude-");
  return false;
}
