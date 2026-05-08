import * as path from "node:path";
import type { IClock } from "../substrate/abstractions/IClock";
import type { IFileSystem } from "../substrate/abstractions/IFileSystem";

export type ShellRouteKind = "commercial-shell" | "portable-shell" | "remote-api" | "self-hosted" | "deterministic-local" | "unknown";
export type ShellRiskLevel = "low" | "medium" | "high";

export interface ShellProviderConfig {
  keyPath?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
  strategicModel?: string;
  tacticalModel?: string;
  idModel?: string;
}

export interface ShellIndependenceConfig {
  sourceCodePath?: string;
  sessionLauncher?: string;
  defaultCodeBackend?: string;
  idLauncher?: string;
  model?: string;
  strategicModel?: string;
  tacticalModel?: string;
  models?: Record<string, ShellProviderConfig>;
  claude?: ShellProviderConfig;
  gemini?: ShellProviderConfig;
  copilot?: ShellProviderConfig;
  codex?: ShellProviderConfig;
  pi?: ShellProviderConfig;
  ollama?: ShellProviderConfig;
  vertex?: ShellProviderConfig;
  groq?: ShellProviderConfig;
  anthropic?: ShellProviderConfig;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  idOllamaModel?: string;
  vertexKeyPath?: string;
  vertexModel?: string;
  groqKeyPath?: string;
  groqModel?: string;
  idGroqModel?: string;
  claudeOAuthKeyPath?: string;
  anthropicModel?: string;
  idAnthropicModel?: string;
  ollamaOffload?: { enabled: boolean };
}

export interface ShellRoute {
  id: string;
  label: string;
  provider: string;
  kind: ShellRouteKind;
  status: "active" | "default" | "fallback" | "available" | "static" | "deterministic";
  risk: ShellRiskLevel;
  model?: string;
  evidence: string[];
}

export interface StaticShellReference {
  id: string;
  file: string;
  symbol: string;
  kind: ShellRouteKind;
}

export interface ShellIndependenceInventory {
  activeCognitiveRoute: ShellRoute;
  codeDispatchRoute: ShellRoute;
  idRoute: ShellRoute;
  deterministicRoutes: ShellRoute[];
  fallbackRoutes: ShellRoute[];
  staticShellReferences: StaticShellReference[];
  notes: string[];
}

export interface ShellIndependenceScorecard {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  riskLevel: ShellRiskLevel;
  activeLauncher: string;
  activeLauncherKind: ShellRouteKind;
  codeDispatchDefault: string;
  commercialShellCount: number;
  remoteApiCount: number;
  deterministicRouteCount: number;
  blockers: string[];
  nextActions: string[];
}

export interface ShellIndependenceSnapshot {
  generatedAt: string;
  inventory: ShellIndependenceInventory;
  scorecard: ShellIndependenceScorecard;
  compactReport: string[];
}

export interface IShellIndependenceService {
  refresh(): Promise<ShellIndependenceSnapshot>;
  getLastSnapshot(): ShellIndependenceSnapshot | null;
}

const COMMERCIAL_SHELLS = new Set(["claude", "codex", "copilot", "gemini"]);
const REMOTE_API_PROVIDERS = new Set(["anthropic", "groq", "vertex", "openrouter", "openai", "google", "gemini", "xai"]);
const SOURCE_SCAN_FILES = [
  "server/src/loop/createAgentLayer.ts",
  "server/src/loop/createLoopLayer.ts",
  "server/src/code-dispatch/CodeDispatcher.ts",
  "server/src/agents/ProviderFallbackLauncher.ts",
  "server/src/config.ts",
];

const STATIC_SYMBOLS: Array<{ symbol: string; provider: string; kind: ShellRouteKind }> = [
  { symbol: "AgentSdkLauncher", provider: "claude", kind: "commercial-shell" },
  { symbol: "ClaudeCliBackend", provider: "claude", kind: "commercial-shell" },
  { symbol: "CodexSessionLauncher", provider: "codex", kind: "commercial-shell" },
  { symbol: "CodexCliBackend", provider: "codex", kind: "commercial-shell" },
  { symbol: "CopilotSessionLauncher", provider: "copilot", kind: "commercial-shell" },
  { symbol: "CopilotBackend", provider: "copilot", kind: "commercial-shell" },
  { symbol: "GeminiSessionLauncher", provider: "gemini", kind: "commercial-shell" },
  { symbol: "GeminiCliBackend", provider: "gemini", kind: "commercial-shell" },
  { symbol: "PiSessionLauncher", provider: "pi", kind: "portable-shell" },
  { symbol: "OllamaSessionLauncher", provider: "ollama", kind: "self-hosted" },
  { symbol: "GroqSessionLauncher", provider: "groq", kind: "remote-api" },
  { symbol: "AnthropicSessionLauncher", provider: "anthropic", kind: "remote-api" },
  { symbol: "VertexSessionLauncher", provider: "vertex", kind: "remote-api" },
];

export class ShellIndependenceService implements IShellIndependenceService {
  private lastSnapshot: ShellIndependenceSnapshot | null = null;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly config: ShellIndependenceConfig,
  ) {}

  async refresh(): Promise<ShellIndependenceSnapshot> {
    const inventory = await this.buildInventory();
    const scorecard = this.buildScorecard(inventory);
    const compactReport = this.buildCompactReport(inventory, scorecard);
    const snapshot: ShellIndependenceSnapshot = {
      generatedAt: this.clock.now().toISOString(),
      inventory,
      scorecard,
      compactReport,
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  getLastSnapshot(): ShellIndependenceSnapshot | null {
    return this.lastSnapshot;
  }

  private async buildInventory(): Promise<ShellIndependenceInventory> {
    const activeLauncher = this.config.sessionLauncher ?? "claude";
    const activeCognitiveRoute = this.routeForProvider(activeLauncher, "active");
    const codeDispatchRoute = this.routeForCodeBackend(this.config.defaultCodeBackend ?? "auto");
    const idRoute = this.routeForProvider(this.config.idLauncher ?? activeLauncher, "active", "id");
    const staticShellReferences = await this.scanStaticShellReferences();
    const fallbackRoutes = this.buildFallbackRoutes(activeLauncher);
    const deterministicRoutes = [
      this.deterministicRoute("shell-independence", "Shell-independence scorecard endpoint", "GET /api/shell-independence"),
      this.deterministicRoute("metrics-query", "Usage and cost metrics SQL endpoint", "POST /api/metrics/query"),
      this.deterministicRoute("agora-send", "Agora send endpoint", "POST /api/agora/send"),
      this.deterministicRoute("code-dispatch", "Code dispatch endpoint", "POST /api/code-dispatch/invoke"),
    ];
    const notes = [
      "Inventory is deterministic: config fields plus bounded static source scan.",
      "Static references are allowed when inactive and behind provider routing; they still count as residual coupling.",
    ];

    if (activeLauncher === "pi") {
      const piProvider = this.piProvider();
      notes.push(`Pi shell provider is ${piProvider ?? "default"}; shell is portable, model API may still be remote.`);
    }
    if ((this.config.defaultCodeBackend ?? "auto") === "auto") {
      notes.push("defaultCodeBackend=auto currently resolves to Codex in CodeDispatcher.");
    }

    return {
      activeCognitiveRoute,
      codeDispatchRoute,
      idRoute,
      deterministicRoutes,
      fallbackRoutes,
      staticShellReferences,
      notes,
    };
  }

  private routeForProvider(providerName: string, status: ShellRoute["status"], role = "cognitive"): ShellRoute {
    const provider = providerName.toLowerCase();
    const providerConfig = this.providerConfig(provider);
    const kind = this.kindForProvider(provider);
    const model = (role === "id" ? providerConfig?.idModel : undefined)
      ?? providerConfig?.model
      ?? this.legacyModelForProvider(provider, role)
      ?? this.config.model;
    const evidence = [`${role} launcher: ${providerName}`];
    if (model) evidence.push(`model: ${model}`);
    if (provider === "pi") {
      const piProvider = this.piProvider();
      if (piProvider) evidence.push(`pi.provider: ${piProvider}`);
    }
    if (provider === "ollama") {
      evidence.push(`baseUrl: ${providerConfig?.baseUrl ?? this.config.ollamaBaseUrl ?? "http://localhost:11434"}`);
    }
    return {
      id: `${role}:${provider}`,
      label: `${role} via ${providerName}`,
      provider,
      kind,
      status,
      risk: riskForKind(kind),
      ...(model ? { model } : {}),
      evidence,
    };
  }

  private routeForCodeBackend(defaultBackend: string): ShellRoute {
    const provider = defaultBackend === "auto" ? "codex" : defaultBackend.toLowerCase();
    const providerConfig = this.providerConfig(provider);
    const kind = this.kindForProvider(provider);
    const model = providerConfig?.tacticalModel ?? providerConfig?.model ?? this.config.tacticalModel;
    const evidence = [
      `defaultCodeBackend: ${defaultBackend}`,
      defaultBackend === "auto" ? "auto dispatch resolves to Codex backend" : `code backend: ${provider}`,
    ];
    if (model) evidence.push(`model: ${model}`);
    return {
      id: `code:${provider}`,
      label: `code dispatch via ${provider}`,
      provider,
      kind,
      status: "default",
      risk: riskForKind(kind),
      ...(model ? { model } : {}),
      evidence,
    };
  }

  private deterministicRoute(id: string, label: string, evidence: string): ShellRoute {
    return {
      id,
      label,
      provider: "substrate",
      kind: "deterministic-local",
      status: "deterministic",
      risk: "low",
      evidence: [evidence],
    };
  }

  private buildFallbackRoutes(activeLauncher: string): ShellRoute[] {
    const routes: ShellRoute[] = [];
    if (activeLauncher !== "ollama") {
      routes.push(this.routeForProvider("ollama", "fallback"));
    }
    if (this.config.vertex?.keyPath ?? this.config.vertexKeyPath) {
      routes.push(this.routeForProvider("vertex", "fallback"));
    }
    if (this.config.groq?.keyPath ?? this.config.groqKeyPath) {
      routes.push(this.routeForProvider("groq", "fallback"));
    }
    if (this.config.anthropic?.keyPath ?? this.config.claudeOAuthKeyPath) {
      routes.push(this.routeForProvider("anthropic", "fallback"));
    }
    if (this.config.ollamaOffload?.enabled) {
      routes.push({
        ...this.routeForProvider("ollama", "available"),
        id: "offload:ollama",
        label: "conversation compaction via ollama",
      });
    }
    return routes;
  }

  private async scanStaticShellReferences(): Promise<StaticShellReference[]> {
    const sourceRoot = this.config.sourceCodePath;
    if (!sourceRoot) return [];
    const references: StaticShellReference[] = [];
    for (const relativePath of SOURCE_SCAN_FILES) {
      const filePath = joinPath(sourceRoot, relativePath);
      if (!(await this.fs.exists(filePath))) continue;
      const content = await this.fs.readFile(filePath);
      for (const entry of STATIC_SYMBOLS) {
        if (!content.includes(entry.symbol)) continue;
        references.push({
          id: `${relativePath}:${entry.symbol}`,
          file: relativePath,
          symbol: entry.symbol,
          kind: entry.kind,
        });
      }
    }
    return references;
  }

  private buildScorecard(inventory: ShellIndependenceInventory): ShellIndependenceScorecard {
    let score = 100;
    const blockers: string[] = [];
    const nextActions: string[] = [];
    const activeKind = inventory.activeCognitiveRoute.kind;
    const codeKind = inventory.codeDispatchRoute.kind;

    if (activeKind === "commercial-shell") {
      score -= 30;
      blockers.push(`active cognitive launcher is commercial shell: ${inventory.activeCognitiveRoute.provider}`);
      nextActions.push("Move cognitive execution to a portable shell or self-hosted agent runtime.");
    } else if (activeKind === "remote-api") {
      score -= 18;
      nextActions.push("Keep remote API routes behind provider interfaces and maintain a local fallback.");
    } else if (activeKind === "portable-shell") {
      score -= this.piUsesRemoteProvider() ? 12 : 6;
      if (this.piUsesRemoteProvider()) {
        nextActions.push("Evaluate a self-hosted model/provider path for the portable Pi shell.");
      }
    }

    if (codeKind === "commercial-shell") {
      score -= 22;
      blockers.push(`default code dispatch depends on commercial shell: ${inventory.codeDispatchRoute.provider}`);
      nextActions.push("Replace default code dispatch with a portable backend or require explicit backend selection.");
    } else if (codeKind === "remote-api") {
      score -= 12;
    }

    if (inventory.idRoute.kind === "commercial-shell") {
      score -= 10;
      nextActions.push("Route Id through a lower-cost portable or self-hosted launcher.");
    }

    const staticCommercialCount = inventory.staticShellReferences.filter((ref) => ref.kind === "commercial-shell").length;
    if (staticCommercialCount > 0) {
      score -= Math.min(12, staticCommercialCount * 2);
      nextActions.push("Keep legacy commercial launchers behind provider interfaces and avoid broadening their call sites.");
    }

    if (!this.hasLocalModelRoute(inventory)) {
      score -= 10;
      blockers.push("no configured self-hosted cognitive or fallback route detected");
      nextActions.push("Configure an Ollama/local route as an emergency fallback.");
    }

    const commercialShellCount = [
      inventory.activeCognitiveRoute,
      inventory.codeDispatchRoute,
      inventory.idRoute,
      ...inventory.fallbackRoutes,
    ].filter((route) => route.kind === "commercial-shell").length + staticCommercialCount;
    const remoteApiCount = [
      inventory.activeCognitiveRoute,
      inventory.codeDispatchRoute,
      inventory.idRoute,
      ...inventory.fallbackRoutes,
    ].filter((route) => route.kind === "remote-api").length + (this.piUsesRemoteProvider() ? 1 : 0);

    score = clamp(score, 0, 100);
    return {
      score,
      grade: gradeForScore(score),
      riskLevel: riskLevelForScore(score),
      activeLauncher: inventory.activeCognitiveRoute.provider,
      activeLauncherKind: activeKind,
      codeDispatchDefault: inventory.codeDispatchRoute.provider,
      commercialShellCount,
      remoteApiCount,
      deterministicRouteCount: inventory.deterministicRoutes.length,
      blockers: unique(blockers),
      nextActions: unique(nextActions).slice(0, 5),
    };
  }

  private buildCompactReport(inventory: ShellIndependenceInventory, scorecard: ShellIndependenceScorecard): string[] {
    const lines = [
      `Shell independence score: ${scorecard.score}/100 (${scorecard.grade}, ${scorecard.riskLevel} risk)`,
      `Active cognitive launcher: ${inventory.activeCognitiveRoute.provider} (${inventory.activeCognitiveRoute.kind})`,
      `Code dispatch default: ${inventory.codeDispatchRoute.provider} (${inventory.codeDispatchRoute.kind})`,
      `Id launcher: ${inventory.idRoute.provider} (${inventory.idRoute.kind})`,
      `Static commercial shell references: ${inventory.staticShellReferences.filter((ref) => ref.kind === "commercial-shell").length}`,
      `Deterministic local routes: ${scorecard.deterministicRouteCount}`,
    ];
    if (scorecard.blockers.length > 0) {
      lines.push(`Blockers: ${scorecard.blockers.join("; ")}`);
    }
    if (scorecard.nextActions.length > 0) {
      lines.push(`Next actions: ${scorecard.nextActions.join("; ")}`);
    }
    return lines;
  }

  private providerConfig(provider: string): ShellProviderConfig | undefined {
    return (this.config as Record<string, ShellProviderConfig | undefined>)[provider] ?? this.config.models?.[provider];
  }

  private legacyModelForProvider(provider: string, role: string): string | undefined {
    if (provider === "ollama") {
      return role === "id"
        ? this.config.idOllamaModel ?? this.config.ollamaModel
        : this.config.ollamaModel;
    }
    if (provider === "groq") {
      return role === "id"
        ? this.config.idGroqModel ?? this.config.groqModel
        : this.config.groqModel;
    }
    if (provider === "anthropic") {
      return role === "id"
        ? this.config.idAnthropicModel ?? this.config.anthropicModel
        : this.config.anthropicModel;
    }
    if (provider === "vertex") {
      return this.config.vertexModel;
    }
    return undefined;
  }

  private kindForProvider(provider: string): ShellRouteKind {
    if (COMMERCIAL_SHELLS.has(provider)) return "commercial-shell";
    if (provider === "pi") return "portable-shell";
    if (provider === "ollama") return "self-hosted";
    if (REMOTE_API_PROVIDERS.has(provider)) return "remote-api";
    return "unknown";
  }

  private piProvider(): string | undefined {
    const configured = this.config.pi?.provider;
    if (configured) return configured;
    const model = this.config.pi?.model ?? this.config.model;
    const prefix = model?.split("/", 1)[0];
    return prefix && prefix !== model ? prefix : undefined;
  }

  private piUsesRemoteProvider(): boolean {
    const provider = this.piProvider()?.toLowerCase();
    return !!provider && provider !== "ollama" && provider !== "local";
  }

  private hasLocalModelRoute(inventory: ShellIndependenceInventory): boolean {
    return [
      inventory.activeCognitiveRoute,
      inventory.idRoute,
      ...inventory.fallbackRoutes,
    ].some((route) => route.kind === "self-hosted");
  }
}

function riskForKind(kind: ShellRouteKind): ShellRiskLevel {
  switch (kind) {
    case "commercial-shell":
      return "high";
    case "remote-api":
    case "portable-shell":
      return "medium";
    case "self-hosted":
    case "deterministic-local":
      return "low";
    default:
      return "medium";
  }
}

function gradeForScore(score: number): ShellIndependenceScorecard["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function riskLevelForScore(score: number): ShellRiskLevel {
  if (score >= 75) return "low";
  if (score >= 50) return "medium";
  return "high";
}

function joinPath(base: string, relativePath: string): string {
  if (base.startsWith("/") && !/^[a-zA-Z]:/.test(base)) {
    return path.posix.join(base, relativePath);
  }
  return path.join(base, relativePath);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
