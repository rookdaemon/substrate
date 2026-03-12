import * as path from "path";
import { PermissionChecker } from "../agents/permissions";
import { PromptBuilder } from "../agents/prompts/PromptBuilder";
import { AgentSdkLauncher, SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import { GeminiSessionLauncher } from "../agents/gemini/GeminiSessionLauncher";
import { CopilotSessionLauncher } from "../agents/copilot/CopilotSessionLauncher";
import { OllamaSessionLauncher } from "../agents/ollama/OllamaSessionLauncher";
import { OllamaInferenceClient } from "../agents/ollama/OllamaInferenceClient";
import { OllamaOffloadService } from "../agents/ollama/OllamaOffloadService";
import { FetchHttpClient } from "../agents/ollama/FetchHttpClient";
import { VertexSessionLauncher } from "../agents/vertex/VertexSessionLauncher";
import { ProcessTracker, ProcessTrackerConfig } from "../agents/claude/ProcessTracker";
import { NodeProcessKiller } from "../agents/claude/NodeProcessKiller";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { ApiSemaphore } from "../agents/claude/ApiSemaphore";
import { SemaphoreSessionLauncher } from "../agents/claude/SemaphoreSessionLauncher";
import { ISessionLauncher } from "../agents/claude/ISessionLauncher";
import { TaskClassifier } from "../agents/TaskClassifier";
import { ConversationCompactor } from "../conversation/ConversationCompactor";
import { ConversationArchiver } from "../conversation/ConversationArchiver";
import { ConversationManager, ConversationArchiveConfig } from "../conversation/ConversationManager";
import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { AgentRole } from "../agents/types";
import { WorkspaceManager } from "../agents/workspace/WorkspaceManager";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { DriveQualityTracker } from "../evaluation/DriveQualityTracker";
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
  flashGate: IFlashGate | null;
  ego: Ego;
  subconscious: Subconscious;
  superego: Superego;
  id: Id;
  /** VertexSessionLauncher for subprocess tasks (compaction, gates). Undefined if not configured. */
  vertexSubprocessLauncher: VertexSessionLauncher | undefined;
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

  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker, {
    substratePath: config.substratePath,
    sourceCodePath: config.sourceCodePath,
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
  const launcher = new AgentSdkLauncher(sdkQuery, clock, config.model, logger, processTracker, mcpServers);

  // API semaphore — caps concurrent Claude sessions for rate-limit safety
  const apiSemaphore = new ApiSemaphore(config.maxConcurrentSessions ?? 2);

  // Cognitive role launcher — switch based on sessionLauncher config
  let gatedLauncher: ISessionLauncher;
  if (config.sessionLauncher === "gemini") {
    logger.debug("agent-layer: using GeminiSessionLauncher for cognitive roles");
    const geminiLauncher = new GeminiSessionLauncher(new NodeProcessRunner(), clock, config.model);
    gatedLauncher = new SemaphoreSessionLauncher(geminiLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "copilot") {
    logger.debug("agent-layer: using CopilotSessionLauncher for cognitive roles");
    const copilotLauncher = new CopilotSessionLauncher(new NodeProcessRunner(), clock, config.model);
    gatedLauncher = new SemaphoreSessionLauncher(copilotLauncher, apiSemaphore);
  } else if (config.sessionLauncher === "ollama") {
    const ollamaBaseUrl = config.ollamaBaseUrl ?? "http://localhost:11434";
    logger.debug(`agent-layer: using OllamaSessionLauncher for cognitive roles (${ollamaBaseUrl}, model: ${config.ollamaModel ?? "default"})`);
    const ollamaLauncher = new OllamaSessionLauncher(new FetchHttpClient(), clock, config.ollamaModel, ollamaBaseUrl);
    gatedLauncher = new SemaphoreSessionLauncher(ollamaLauncher, apiSemaphore);
  } else {
    gatedLauncher = new SemaphoreSessionLauncher(launcher, apiSemaphore);
  }

  // Metrics collection components
  const taskMetrics = new TaskClassificationMetrics(fs, clock, config.substratePath);
  const sizeTracker = new SubstrateSizeTracker(fs, clock, config.substratePath);
  const delegationTracker = new DelegationTracker(fs, clock, config.substratePath);

  // Task classifier for model selection (with optional metrics collection)
  const taskClassifier = new TaskClassifier({
    strategicModel: config.strategicModel ?? "opus",
    tacticalModel: config.tacticalModel ?? "sonnet",
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
    const ollamaBaseUrl = config.ollamaBaseUrl ?? "http://localhost:11434";
    const ollamaModel = config.ollamaModel ?? "qwen3:14b";
    logger.debug(`agent-layer: Ollama offload enabled (${ollamaBaseUrl}, model: ${ollamaModel})`);
    const inferenceClient = new OllamaInferenceClient(
      new FetchHttpClient(),
      ollamaBaseUrl,
      ollamaModel,
      logger,
    );
    ollamaOffloadService = new OllamaOffloadService(inferenceClient, clock, logger);
  }

  // Vertex subprocess launcher — middle-tier fallback between Ollama and Claude
  let vertexSubprocessLauncher: VertexSessionLauncher | undefined;
  if (config.vertexKeyPath) {
    try {
      const { readFileSync } = await import("node:fs");
      const apiKey = readFileSync(config.vertexKeyPath, "utf8").trim();
      if (apiKey) {
        const vertexLauncher = new VertexSessionLauncher(
          new FetchHttpClient(),
          clock,
          apiKey,
          config.vertexModel,
        );
        // Startup health probe — fail-fast if key is invalid (Bishop Q2)
        const isHealthy = await vertexLauncher.healthy();
        if (isHealthy) {
          vertexSubprocessLauncher = vertexLauncher;
          logger.debug(`agent-layer: Vertex subprocess launcher enabled (model: ${config.vertexModel ?? "gemini-2.5-flash"})`);
        } else {
          logger.debug("agent-layer: Vertex subprocess launcher health check FAILED — key may be invalid, disabling");
        }
      } else {
        logger.debug("agent-layer: Vertex key file is empty — disabling subprocess launcher");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log path existence failure without revealing path contents (security: key path is [REDACTED])
      logger.debug(`agent-layer: Cannot read Vertex key file — disabling subprocess launcher (${msg.replace(config.vertexKeyPath, "[REDACTED]")})`);
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
  const driveQualityTracker = new DriveQualityTracker(fs, driveRatingsPath);

  const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, gatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.EGO), config.sourceCodePath);
  const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, gatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.SUBCONSCIOUS));
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, gatedLauncher, clock, taskClassifier, writer, workspaceManager.workspacePath(AgentRole.SUPEREGO));

  // Id launcher — defaults to gatedLauncher; routes to VertexSessionLauncher when idLauncher === "vertex".
  // VertexSessionLauncher silently ignores continueSession/persistSession flags (reads only model and timeoutMs).
  // This is a semantic no-op for Id: Id produces stateless advisory output and does not need cross-call session continuity.
  let idGatedLauncher: ISessionLauncher = gatedLauncher;
  if (config.idLauncher === "vertex" && vertexSubprocessLauncher) {
    idGatedLauncher = new SemaphoreSessionLauncher(vertexSubprocessLauncher, apiSemaphore);
    logger.debug("agent-layer: Id using VertexSessionLauncher (idLauncher: vertex)");
  } else if (config.idLauncher === "vertex") {
    logger.debug("agent-layer: idLauncher is \"vertex\" but no Vertex launcher available — Id falling back to default launcher");
  }

  const id = new Id(reader, checker, promptBuilder, idGatedLauncher, clock, taskClassifier, workspaceManager.workspacePath(AgentRole.ID), driveQualityTracker, logger);

  return {
    checker, promptBuilder, launcher, gatedLauncher, apiSemaphore, processTracker,
    taskMetrics, sizeTracker, delegationTracker, taskClassifier,
    conversationManager, driveQualityTracker, flashGate,
    ego, subconscious, superego, id,
    vertexSubprocessLauncher,
  };
}
