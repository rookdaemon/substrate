import * as path from "path";
import { NodeFileSystem } from "../substrate/abstractions/NodeFileSystem";
import { SystemClock } from "../substrate/abstractions/SystemClock";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { FileLock } from "../substrate/io/FileLock";
import { PermissionChecker } from "../agents/permissions";
import { PromptBuilder } from "../agents/prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../agents/claude/ClaudeSessionLauncher";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { FileLogger } from "../logging";
import { NodeTimer } from "./NodeTimer";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { IdleHandler } from "./IdleHandler";
import { LoopHttpServer } from "./LoopHttpServer";
import { LoopWebSocketServer } from "./LoopWebSocketServer";
import { defaultLoopConfig } from "./types";
import { HealthCheck } from "../evaluation/HealthCheck";

export interface ApplicationConfig {
  substratePath: string;
  workingDirectory?: string;
  model?: string;
  httpPort?: number;
  cycleDelayMs?: number;
  superegoAuditInterval?: number;
  maxConsecutiveIdleCycles?: number;
}

export interface Application {
  orchestrator: LoopOrchestrator;
  httpServer: LoopHttpServer;
  wsServer: LoopWebSocketServer;
  logPath: string;
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
}

export function createApplication(config: ApplicationConfig): Application {
  // Substrate layer
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const substrateConfig = new SubstrateConfig(config.substratePath);
  const reader = new SubstrateFileReader(fs, substrateConfig);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, substrateConfig, lock);
  const appendWriter = new AppendOnlyWriter(fs, substrateConfig, lock, clock);

  // Agent layer
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker, {
    substratePath: config.substratePath,
    sourceCodePath: config.workingDirectory,
  });
  const runner = new NodeProcessRunner();
  const launcher = new ClaudeSessionLauncher(runner, clock, config.model);

  const cwd = config.workingDirectory;
  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock, cwd);
  const subconscious = new Subconscious(reader, writer, appendWriter, checker, promptBuilder, launcher, clock, cwd);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, cwd);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, cwd);

  // Loop layer — build httpServer first for the underlying http.Server,
  // then wsServer, then orchestrator, then wire orchestrator back into httpServer
  const loopConfig = defaultLoopConfig({
    cycleDelayMs: config.cycleDelayMs,
    superegoAuditInterval: config.superegoAuditInterval,
    maxConsecutiveIdleCycles: config.maxConsecutiveIdleCycles,
  });

  const logPath = path.resolve(config.substratePath, "..", "debug.log");
  const logger = new FileLogger(logPath);

  const httpServer = new LoopHttpServer(null as unknown as LoopOrchestrator);
  const wsServer = new LoopWebSocketServer(httpServer.getServer());
  const timer = new NodeTimer();

  const idleHandler = new IdleHandler(id, superego, ego, appendWriter, clock, logger);

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id,
    appendWriter, clock, timer, wsServer, loopConfig,
    logger, idleHandler
  );

  httpServer.setOrchestrator(orchestrator);
  httpServer.setDependencies({ reader, ego });
  httpServer.setHealthCheck(new HealthCheck(reader));

  return {
    orchestrator,
    httpServer,
    wsServer,
    logPath,
    async start(port?: number): Promise<number> {
      const p = port ?? config.httpPort ?? 3000;
      return httpServer.listen(p);
    },
    async stop(): Promise<void> {
      try { orchestrator.stop(); } catch { /* already stopped */ }
      wsServer.close();
      await httpServer.close();
    },
  };
}
