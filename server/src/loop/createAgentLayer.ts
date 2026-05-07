import * as path from "path";
import { PermissionChecker } from "../agents/permissions";
import { PromptBuilder } from "../agents/prompts/PromptBuilder";
import { AgentSdkLauncher, SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import { GeminiSessionLauncher } from "../agents/gemini/GeminiSessionLauncher";
import { GeminiMcpSetup } from "../agents/gemini/GeminiMcpSetup";
import { CopilotSessionLauncher } from "../agents/copilot/CopilotSessionLauncher";
import { CodexSessionLauncher } from "../agents/codex/CodexSessionLauncher";
import { CodexMcpSetup } from "../agents/codex/CodexMcpSetup";
import { OllamaSessionLauncher } from "../agents/ollama/OllamaSessionLauncher";
import { OllamaInferenceClient } from "../agents/ollama/OllamaInferenceClient";
import { OllamaOffloadService } from "../agents/ollama/OllamaOffloadService";
import { FetchHttpClient } from "../agents/ollama/FetchHttpClient";
import { GroqSessionLauncher } from "../agents/groq/GroqSessionLauncher";
import { AnthropicSessionLauncher } from "../agents/anthropic/AnthropicSessionLauncher";
import { VertexSessionLauncher } from "../agents/vertex/VertexSessionLauncher";
import { ProcessTracker, ProcessTrackerConfig } from "../agents/claude/ProcessTracker";
import { NodeProcessKiller } from "../agents/claude/NodeProcessKiller";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { ApiSemaphore } from "../agents/claude/ApiSemaphore";
import { SemaphoreSessionLauncher } from "../agents/claude/SemaphoreSessionLauncher";
import { ISessionLauncher } from "../agents/claude/ISessionLauncher";
import { TaskClassifier } from "../agents/TaskClassifier";
import { SurvivalModelPolicyLauncher } from "../agents/SurvivalModelPolicyLauncher";
import { ProviderFallbackLauncher, ProviderFallbackRoute, UnavailableProviderLauncher } from "../agents/ProviderFallbackLauncher";
import { ConversationCompactor } from "../conversation/ConversationCompactor";
import { ConversationArchiver } from "../conversation/ConversationArchiver";
import { ConversationManager, ConversationArchiveConfig } from "../conversation/ConversationManager";
import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { AgentRole } from "../agents/types";
import { CycleLogWriter } from "../substrate/io/CycleLogWriter";
import { WorkspaceManager } from "../agents/workspace/WorkspaceManager";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { DriveQualityTracker } from "../evaluation/DriveQualityTracker";
import { SqliteMetricsService } from "../metrics/SqliteMetricsService";
import { MeteredSessionLauncher } from "../metrics/MeteredSessionLauncher";
import { BudgetGuard } from "../budget/BudgetGuard";
import { FlashGate } from "../gates/FlashGate";
import type { IFlashGate } from "../gates/IFlashGate";
import type { ApplicationConfig } from "./applicationTypes";
import type { SubstrateLayerResult } from "./createSubstrateLayer";

export interface AgentLayerResult {
  checker: PermissionChecker;
  promptBuilder: PromptBuilder;
  launcher: AgentSdkLauncher;
  gatedLauncher: ISessionLauncher;
  apiSemaphore: ApiSemaphore;
  processTracker: ProcessTracker;
  taskMetrics: TaskClassificationMetrics;
  sizeTracker: SubstrateSizeTracker;
  delegationTracker: DelegationTracker;
  taskClassifier: TaskClassifier;
  conversationManager: ConversationManager;
  driveQualityTracker: DriveQualityTracker;
  metricsService: SqliteMetricsService;
  flashGate: IFlashGate | null;
  ego: Ego;
  subconscious: Subconscious;
  superego: Superego;
  id: Id;
  /** VertexSessionLauncher for subprocess tasks (compaction, gates). Undefined if not configured. */
  vertexSubprocessLauncher: VertexSessionLauncher | undefined;
}

type ProviderName = "claude" | "gemini" | "copilot" | "codex" | "ollama" | "vertex" | "groq" | "anthropic";

function providerConfig(config: ApplicationConfig, provider: ProviderName) {
  return config[provider] ?? config.models?.[provider];
}

/**
 * Creates all agent-layer objects: permission checker, prompt builder,
 * process tracker, SDK launcher, task classifier, conversation manager,
 * drive quality tracker, and the four cognitive roles.
 */
export async function createAgentLayer(
  config: ApplicationConfig,
  sdkQuery: SdkQueryFn,
  substrate: SubstrateLayerResult,
): Promise<AgentLayerResult> {
  const { reader, writer, appendWriter, lock, clock, fs, substrateConfig, logger } = substrate;
  const sessionProvider = (config.sessionLauncher ?? "claude") as ProviderName;
  const activeProviderConfig = providerConfig(config, sessionProvider);
  const activeModel = activeProviderConfig?.model ?? config.model;
  const activeStrategicModel = activeProviderConfig?.strategicModel ?? config.strategicModel;
  const activeTacticalModel = activeProviderConfig?.tacticalModel ?? config.tacticalModel;
  const ollamaConfig = providerConfig(config, "ollama");
  const vertexConfig = providerConfig(config, "vertex");
  const groqConfig = providerConfig(config, "groq");
  const anthropicConfig = providerConfig(config, "anthropic");

  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker, {
    substratePath: config.substratePath,
    sourceCodePath: config.sourceCodePath,
    launcherType: config.sessionLauncher ?? "claude",
    conversationPromptWindowLines: config.conversationPromptWindowLines ?? 200,
  });

  // Process tracker for zombie cleanup (created before launcher so we can pass it)
  const processKiller = new NodeProcessKiller();
  const processTrackerConfig: ProcessTrackerConfig = {
    gracePeriodMs: config.abandonedProcessGraceMs ?? 600_000, // Default 10 min
    reaperIntervalMs: 60_000, // Check every minute
  };
  const processTracker = new ProcessTracker(clock, processKiller, processTrackerConfig, logger);
  const DEFAULT_HTTP_PORT = 3000;
  const mcpUrl = `http://localhost:${config.httpPort ?? DEFAULT_HTTP_PORT}/mcp`;
  const mcpServers = {
    tinybus: { type: "http" as const, url: mcpUrl },
    code_dispatch: { type: "http" as const, url: mcpUrl },
  };
  logger.debug(`agent-layer: MCP servers configured: tinybus → ${mcpUrl}, code_dispatch → ${mcpUrl}`);
  const launcher = new AgentSdkLauncher(sdkQuery, clock, activeModel, logger, processTracker, mcpServers);

  // API semaphore — caps concurrent Claude sessions for rate-limit safety
  const apiSemaphore = new ApiSemaphore(config.maxConcurrentSessions ?? 2);
  const metricsService = SqliteMetricsService.forSubstratePath(config.substratePath, logger);
  const budgetGuard = BudgetGuard.forSubstratePath(config.substratePath, fs, clock, logger);
  const withSurvivalPolicy = (
    inner: ISessionLauncher,
    provider: ProviderName,
    defaultModel?: string,
  ): ISessionLauncher => new SurvivalModelPolicyLauncher(
    new MeteredSessionLauncher(inner, metricsService, clock, budgetGuard, provider, defaultModel),
    {
      provider,
      defaultModel,
      configuredFrontierModels: [activeModel, activeStrategicModel, activeTacticalModel].filter((model): model is string => typeof model === "string"),
      allowConfiguredFrontierModels: true,
    },
    logger,
  );

  // Ollama API key — read from key file if configured (never from env vars)
  // Required for authenticated remote Ollama endpoints (e.g. ollama.lbsa71.net).
  let ollamaApiKey: string | undefined;
  const ollamaKeyPath = ollamaConfig?.keyPath ?? config.ollamaKeyPath;
  if (ollamaKeyPath) {
    try {
      const key = (await fs.readFile(ollamaKeyPath)).trim();
      if (key) {
        ollamaApiKey = key;
      } else {
        logger.debug("agent-layer: Ollama key file is empty — unauthenticated requests will be used");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const redacted = msg.replaceAll(ollamaKeyPath, "[REDACTED]");
      logger.debug(`agent-layer: Cannot read Ollama key file — unauthenticated requests will be used (${redacted})`);
    }
  }

  // Groq API key — read from key file if configured (never from env vars)
  let groqApiKey: string | undefined;
  const groqKeyPath = groqConfig?.keyPath ?? config.groqKeyPath;
  const groqModel = groqConfig?.model ?? config.groqModel;
  const idGroqModel = groqConfig?.idModel ?? config.idGroqModel;
  if (groqKeyPath) {
    try {
      const key = (await fs.readFile(groqKeyPath)).trim();
      if (key) {
        groqApiKey = key;
      } else {
        logger.debug("agent-layer: Groq key file is empty — Groq launcher disabled");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const redacted = msg.replaceAll(groqKeyPath, "[REDACTED]");
      logger.debug(`agent-layer: Cannot read Groq key file — Groq launcher disabled (${redacted})`);
    }
  }

  // Anthropic subscription token — read from credentials file if configured (never from env vars)
  let anthropicAccessToken: string | undefined;
  const anthropicKeyPath = anthropicConfig?.keyPath ?? config.claudeOAuthKeyPath;
  const anthropicModel = anthropicConfig?.model ?? config.anthropicModel;
  const idAnthropicModel = anthropicConfig?.idModel ?? config.idAnthropicModel;
  if (anthropicKeyPath) {
    try {
      const raw = await fs.readFile(anthropicKeyPath);
      const json = JSON.parse(raw);
      const token = json?.anthropic?.setupToken as string | undefined;
      if (token?.startsWith("sk-ant-")) {
        anthropicAccessToken = token;
      } else {
        logger.debug("agent-layer: Anthropic token file missing or malformed — Anthropic launcher disabled");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const redacted = msg.replaceAll(anthropicKeyPath, "[REDACTED]");
      logger.debug(`agent-layer: Cannot read Anthropic token file — Anthropic launcher disabled (${redacted})`);
    }
  }

  // Cognitive role launcher — switch based on sessionLauncher config
  let gatedLauncher: ISessionLauncher;
  if (config.sessionLauncher === "gemini") {
    logger.debug("agent-layer: using GeminiSessionLauncher for cognitive roles");
    const geminiLauncher = new GeminiSessionLauncher(new NodeProcessRunner(), clock, activeModel);
    // Register TinyBus in Gemini CLI's MCP config so mcp__tinybus__* tools are available
    const geminiMcpSetup = new GeminiMcpSetup(new NodeProcessRunner(), logger);
    await geminiMcpSetup.register("tinybus", mcpUrl);
    gatedLauncher = new SemaphoreSessionLauncher(geminiLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "copilot") {
    logger.debug("agent-layer: using CopilotSessionLauncher for cognitive roles");
    const copilotLauncher = new CopilotSessionLauncher(new NodeProcessRunner(), clock, activeModel);
    gatedLauncher = new SemaphoreSessionLauncher(copilotLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "codex") {
    logger.debug("agent-layer: using CodexSessionLauncher for cognitive roles");
    const codexLauncher = new CodexSessionLauncher(new NodeProcessRunner(), clock, activeModel, logger);
    const codexMcpSetup = new CodexMcpSetup(new NodeProcessRunner(), logger);
    await codexMcpSetup.register("tinybus", mcpUrl);
    await codexMcpSetup.register("code_dispatch", mcpUrl);
    gatedLauncher = new SemaphoreSessionLauncher(codexLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "ollama") {
    const ollamaBaseUrl = ollamaConfig?.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
    const ollamaModel = ollamaConfig?.model ?? config.ollamaModel;
    logger.debug(`agent-layer: using OllamaSessionLauncher for cognitive roles (${ollamaBaseUrl}, model: ${ollamaModel ?? "default"})`);
    const ollamaLauncher = new OllamaSessionLauncher(new FetchHttpClient(), clock, ollamaModel, ollamaBaseUrl, ollamaApiKey);
    gatedLauncher = new SemaphoreSessionLauncher(ollamaLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "groq") {
    if (groqApiKey) {
      logger.debug(`agent-layer: using GroqSessionLauncher for cognitive roles (model: ${groqModel ?? "default"})`);
      const groqLauncher = new GroqSessionLauncher(new FetchHttpClient(), clock, groqApiKey, groqModel);
      gatedLauncher = new SemaphoreSessionLauncher(groqLauncher, apiSemaphore);
    } else {
      logger.warn("agent-layer: sessionLauncher is \"groq\" but groqKeyPath is not set or key file unreadable — blocking silent fallback to default provider");
      gatedLauncher = new UnavailableProviderLauncher("groq", "groqKeyPath unset or key file unreadable");
    }
  } else if (config.sessionLauncher === "anthropic") {
    if (anthropicAccessToken) {
      logger.debug(`agent-layer: using AnthropicSessionLauncher for cognitive roles (model: ${anthropicModel ?? "default"})`);
      const anthropicLauncher = new AnthropicSessionLauncher(new FetchHttpClient(), clock, anthropicAccessToken, anthropicModel);
      gatedLauncher = new SemaphoreSessionLauncher(anthropicLauncher, apiSemaphore);
    } else {
      logger.warn("agent-layer: sessionLauncher is \"anthropic\" but token unavailable — blocking silent fallback to default provider");
      gatedLauncher = new UnavailableProviderLauncher("anthropic", "claudeOAuthKeyPath unset or token unreadable");
    }
  } else {
    gatedLauncher = new SemaphoreSessionLauncher(launcher, apiSemaphore);
  }

  // Metrics collection components
  const taskMetrics = new TaskClassificationMetrics(fs, clock, config.substratePath);
  const sizeTracker = new SubstrateSizeTracker(fs, clock, config.substratePath);
  const delegationTracker = new DelegationTracker(fs, clock, config.substratePath);

  // Task classifier for model selection (with optional metrics collection)
  const taskClassifier = new TaskClassifier({
    strategicModel: activeStrategicModel ?? "opus",
    tacticalModel: activeTacticalModel ?? "sonnet",
    metricsCollector: config.metrics?.enabled !== false ? taskMetrics : undefined, // Default enabled
  });

  // Per-role workspaces — each role gets its own cwd so Claude Code sessions stay isolated
  const layerPath = path.resolve(config.substratePath, "..");
  const workspaceManager = new WorkspaceManager(fs, layerPath);
  await workspaceManager.ensureWorkspaces();

  const cwd = config.workingDirectory;

  // Ollama offload service — offloads compaction to local Ollama when configured
  let ollamaOffloadService: OllamaOffloadService | undefined;
  if (config.ollamaOffload?.enabled) {
    const ollamaBaseUrl = ollamaConfig?.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
    const ollamaModel = ollamaConfig?.model ?? config.ollamaModel ?? "qwen3:14b";
    logger.debug(`agent-layer: Ollama offload enabled (${ollamaBaseUrl}, model: ${ollamaModel})`);
    const inferenceClient = new OllamaInferenceClient(
      new FetchHttpClient(),
      ollamaBaseUrl,
      ollamaModel,
      logger,
      ollamaApiKey,
    );
    ollamaOffloadService = new OllamaOffloadService(inferenceClient, clock, logger);
  }

  // Vertex subprocess launcher — middle-tier fallback between Ollama and Claude
  let vertexSubprocessLauncher: VertexSessionLauncher | undefined;
  const vertexKeyPath = vertexConfig?.keyPath ?? config.vertexKeyPath;
  const vertexModel = vertexConfig?.model ?? config.vertexModel;
  if (vertexKeyPath) {
    try {
      const apiKey = (await fs.readFile(vertexKeyPath)).trim();
      if (apiKey) {
        const vertexLauncher = new VertexSessionLauncher(
          new FetchHttpClient(),
          clock,
          apiKey,
          vertexModel,
        );
        // Startup health probe — fail-fast if key is invalid (Bishop Q2)
        const isHealthy = await vertexLauncher.healthy();
        if (isHealthy) {
          vertexSubprocessLauncher = vertexLauncher;
          logger.debug(`agent-layer: Vertex subprocess launcher enabled (model: ${vertexModel ?? "gemini-2.5-flash"})`);
        } else {
          logger.debug("agent-layer: Vertex subprocess launcher health check FAILED — key may be invalid, disabling");
        }
      } else {
        logger.debug("agent-layer: Vertex key file is empty — disabling subprocess launcher");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log path existence failure without revealing path contents (security: key path is [REDACTED])
      logger.debug(`agent-layer: Cannot read Vertex key file — disabling subprocess launcher (${msg.replace(vertexKeyPath, "[REDACTED]")})`);
    }
  }

  // FlashGate — F1/F2 behavioral filter gates via Vertex (gemini-2.5-flash)
  // Only enabled when vertexSubprocessLauncher is available (requires valid API key).
  let flashGate: IFlashGate | null = null;
  if (vertexSubprocessLauncher) {
    flashGate = new FlashGate(vertexSubprocessLauncher, clock, logger);
    logger.debug("agent-layer: FlashGate enabled (F1/F2 behavioral filter gates via Vertex)");
  } else {
    logger.debug("agent-layer: FlashGate disabled — no Vertex subprocess launcher available");
  }

  const fallbackRoutes: ProviderFallbackRoute[] = [];
  if (sessionProvider !== "ollama") {
    const ollamaBaseUrl = ollamaConfig?.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
    const ollamaModel = ollamaConfig?.model ?? config.ollamaModel ?? "qwen3:14b";
    const ollamaLauncher = new OllamaSessionLauncher(new FetchHttpClient(), clock, ollamaModel, ollamaBaseUrl, ollamaApiKey);
    fallbackRoutes.push({
      provider: "ollama",
      model: ollamaModel,
      launcher: withSurvivalPolicy(new SemaphoreSessionLauncher(ollamaLauncher, apiSemaphore), "ollama", ollamaModel),
    });
  }
  if (vertexSubprocessLauncher && sessionProvider !== "vertex") {
    fallbackRoutes.push({
      provider: "vertex",
      model: "gemini-2.5-flash",
      launcher: withSurvivalPolicy(new SemaphoreSessionLauncher(vertexSubprocessLauncher, apiSemaphore), "vertex", "gemini-2.5-flash"),
    });
  }
  if (groqApiKey && sessionProvider !== "groq") {
    const groqFallbackModel = "llama-3.1-8b-instant";
    const groqFallbackLauncher = new GroqSessionLauncher(new FetchHttpClient(), clock, groqApiKey, groqFallbackModel);
    fallbackRoutes.push({
      provider: "groq",
      model: groqFallbackModel,
      launcher: withSurvivalPolicy(new SemaphoreSessionLauncher(groqFallbackLauncher, apiSemaphore), "groq", groqFallbackModel),
    });
  }
  if (anthropicAccessToken && sessionProvider !== "anthropic") {
    const anthropicFallbackModel = "claude-haiku-4-20250514";
    const anthropicFallbackLauncher = new AnthropicSessionLauncher(new FetchHttpClient(), clock, anthropicAccessToken, anthropicFallbackModel);
    fallbackRoutes.push({
      provider: "anthropic",
      model: anthropicFallbackModel,
      launcher: withSurvivalPolicy(new SemaphoreSessionLauncher(anthropicFallbackLauncher, apiSemaphore), "anthropic", anthropicFallbackModel),
    });
  }
  gatedLauncher = new ProviderFallbackLauncher(
    withSurvivalPolicy(gatedLauncher, sessionProvider, activeModel),
    fallbackRoutes,
    logger,
  );

  // Conversation manager with compaction and optional archiving
  const compactor = new ConversationCompactor(gatedLauncher, cwd, ollamaOffloadService, logger, vertexSubprocessLauncher);

  let archiver: ConversationArchiver | undefined;
  let archiveConfig: ConversationArchiveConfig | undefined;

  if (config.conversationArchive?.enabled) {
    archiver = new ConversationArchiver(fs, clock, config.substratePath);
    archiveConfig = {
      enabled: config.conversationArchive.enabled,
      linesToKeep: config.conversationArchive.linesToKeep,
      sizeThreshold: config.conversationArchive.sizeThreshold,
      timeThresholdMs: config.conversationArchive.timeThresholdDays
        ? config.conversationArchive.timeThresholdDays * 24 * 60 * 60 * 1000
        : undefined,
    };
  }

  const conversationManager = new ConversationManager(
    reader, fs, substrateConfig, lock, appendWriter, checker, compactor, clock,
    archiver, archiveConfig,
  );

  // Drive quality tracker — persists Id drive ratings for learning loop
  const driveRatingsPath = path.resolve(config.substratePath, "..", "data", "drive-ratings.jsonl");
  const driveQualityTracker = new DriveQualityTracker(fs, driveRatingsPath, logger);

  // Cycle log writer — routes EGO narration and task summaries to cycle_log.md (D-01 fix)
  const cycleLogWriter = new CycleLogWriter(fs, clock, config.substratePath);

  const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, gatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.EGO), config.sourceCodePath, cycleLogWriter);
  const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, gatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.SUBCONSCIOUS), cycleLogWriter);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, gatedLauncher, clock, taskClassifier, writer, workspaceManager.workspacePath(AgentRole.SUPEREGO), logger);

  // Id launcher — defaults to gatedLauncher; routes to VertexSessionLauncher when idLauncher === "vertex".
  // VertexSessionLauncher silently ignores continueSession/persistSession flags (reads only model and timeoutMs).
  // This is a semantic no-op for Id: Id produces stateless advisory output and does not need cross-call session continuity.
  let idGatedLauncher: ISessionLauncher = gatedLauncher;
  if (config.idLauncher === "vertex" && vertexSubprocessLauncher) {
    idGatedLauncher = withSurvivalPolicy(new SemaphoreSessionLauncher(vertexSubprocessLauncher, apiSemaphore), "vertex", vertexModel);
    logger.debug("agent-layer: Id using VertexSessionLauncher (idLauncher: vertex)");
  } else if (config.idLauncher === "vertex") {
    logger.warn("agent-layer: idLauncher is \"vertex\" but no Vertex launcher available — blocking silent fallback to default provider");
    idGatedLauncher = new ProviderFallbackLauncher(
      new UnavailableProviderLauncher("vertex", "vertexKeyPath unset, unreadable, or unhealthy"),
      fallbackRoutes,
      logger,
    );
  } else if (config.idLauncher === "ollama") {
    const ollamaBaseUrl = ollamaConfig?.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
    const ollamaModel = ollamaConfig?.idModel ?? config.idOllamaModel ?? ollamaConfig?.model ?? config.ollamaModel;
    const ollamaLauncher = new OllamaSessionLauncher(new FetchHttpClient(), clock, ollamaModel, ollamaBaseUrl, ollamaApiKey);
    idGatedLauncher = withSurvivalPolicy(new SemaphoreSessionLauncher(ollamaLauncher, apiSemaphore), "ollama", ollamaModel);
    logger.debug(`agent-layer: Id using OllamaSessionLauncher (idLauncher: ollama, model: ${ollamaModel ?? "default"})`);
  } else if (config.idLauncher === "groq") {
    if (groqApiKey) {
      const model = idGroqModel ?? groqModel;
      const groqLauncher = new GroqSessionLauncher(new FetchHttpClient(), clock, groqApiKey, model);
      idGatedLauncher = withSurvivalPolicy(new SemaphoreSessionLauncher(groqLauncher, apiSemaphore), "groq", model);
      logger.debug(`agent-layer: Id using GroqSessionLauncher (idLauncher: groq, model: ${model ?? "default"})`);
    } else {
      logger.warn("agent-layer: idLauncher is \"groq\" but groqKeyPath is not set or key file unreadable — blocking silent fallback to default provider");
      idGatedLauncher = new ProviderFallbackLauncher(
        new UnavailableProviderLauncher("groq", "groqKeyPath unset or key file unreadable"),
        fallbackRoutes,
        logger,
      );
    }
  } else if (config.idLauncher === "anthropic") {
    if (anthropicAccessToken) {
      const model = idAnthropicModel ?? anthropicModel;
      const anthropicLauncher = new AnthropicSessionLauncher(new FetchHttpClient(), clock, anthropicAccessToken, model);
      idGatedLauncher = withSurvivalPolicy(new SemaphoreSessionLauncher(anthropicLauncher, apiSemaphore), "anthropic", model);
      logger.debug(`agent-layer: Id using AnthropicSessionLauncher (idLauncher: anthropic, model: ${model ?? "default"})`);
    } else {
      logger.warn("agent-layer: idLauncher is \"anthropic\" but token unavailable — blocking silent fallback to default provider");
      idGatedLauncher = new ProviderFallbackLauncher(
        new UnavailableProviderLauncher("anthropic", "claudeOAuthKeyPath unset or token unreadable"),
        fallbackRoutes,
        logger,
      );
    }
  }

  const id = new Id(reader, checker, promptBuilder, idGatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.ID), driveQualityTracker, logger);

  return {
    checker, promptBuilder, launcher, gatedLauncher, apiSemaphore, processTracker,
    taskMetrics, sizeTracker, delegationTracker, taskClassifier,
    conversationManager, driveQualityTracker, metricsService, flashGate,
    ego, subconscious, superego, id,
    vertexSubprocessLauncher,
  };
}
