import { SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import { ApplicationConfig, Application } from "./applicationTypes";
import { createSubstrateLayer } from "./createSubstrateLayer";
import { createAgentLayer } from "./createAgentLayer";
import { createLoopLayer } from "./createLoopLayer";

// Re-export shared types so existing consumers are unaffected.
export type { ApplicationConfig, Application } from "./applicationTypes";

export async function createApplication(config: ApplicationConfig): Promise<Application> {
  // SDK — dynamic import required (ESM package in CommonJS project)
  // Tests inject sdkQueryFn directly to avoid dynamic import issues in Jest
  const sdkQuery = config.sdkQueryFn
    ?? (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as SdkQueryFn;

  const substrate = await createSubstrateLayer(config.substratePath, config.logLevel, config.enableFileReadCache, config.progressMaxBytes);
  const agents = await createAgentLayer(config, sdkQuery, substrate);
  const loop = await createLoopLayer(config, sdkQuery, substrate, agents);

  const { orchestrator, httpServer, wsServer, fileWatcher, mode } = loop;

  return {
    orchestrator,
    httpServer,
    wsServer,
    fileWatcher,
    logPath: substrate.logPath,
    async start(port?: number, forceStart?: boolean): Promise<number> {
      const p = port ?? config.httpPort ?? 3000;
      const boundPort = await httpServer.listen(p);
      // Start file watcher to emit file_changed events
      fileWatcher.start();
      if (forceStart) {
        const previousState = orchestrator.getState();
        orchestrator.start();
        // Only start loop if transitioning from STOPPED — SLEEPING delegates to wake() internally
        if (previousState === "STOPPED") {
          if (mode === "tick") {
            orchestrator.runTickLoop().catch(() => {});
          } else {
            orchestrator.runLoop().catch(() => {});
          }
        }
      }
      return boundPort;
    },
    async stop(): Promise<void> {
      try { orchestrator.stop(); } catch { /* already stopped */ }
      fileWatcher.stop();
      await wsServer.close();
      await httpServer.close();
    },
    mode,
  };
}
