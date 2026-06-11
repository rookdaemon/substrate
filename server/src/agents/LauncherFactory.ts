/**
 * LauncherFactory – creates ISessionLauncher instances for a given provider.
 *
 * This module centralizes launcher construction so that createAgentLayer.ts
 * can remain provider-agnostic.  All heavy provider-specific imports are
 * deferred to the call sites so that unused launchers are never statically
 * imported.
 *
 * Design notes:
 * - Each async factory dynamically imports the concrete launcher class.
 * - Type safety is preserved via the ISessionLauncher interface.
 * - MCP setup (Gemini/Codex) is handled separately in createAgentLayer after
 *   the launcher is returned.
 */

import type { ISessionLauncher } from "./claude/ISessionLauncher";
import type { IProcessRunner } from "./claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { ILogger } from "../logging";
import type { IHttpClient } from "./ollama/IHttpClient";
import type { ReasoningEffort } from "./reasoningEffort";

export type ProviderName =
  | "claude"
  | "gemini"
  | "copilot"
  | "codex"
  | "pi"
  | "ollama"
  | "vertex"
  | "groq"
  | "anthropic";

export interface LauncherFactoryDeps {
  runner: IProcessRunner;
  httpClient: IHttpClient;
  clock: IClock;
  logger: ILogger;
}

export interface PiLauncherArgs {
  provider?: string;
  model?: string;
  mode?: "json" | "print";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sessionDir?: string;
  apiToken?: string;
  providerEnv?: Record<string, string | undefined>;
  defaultTimeoutMs?: number;
  defaultIdleTimeoutMs?: number;
  maxLoggedTextChars?: number;
  minLoggedTextChars?: number;
}

export interface OllamaLauncherArgs {
  model?: string;
  baseUrl: string;
  apiKey?: string;
}

export interface GroqLauncherArgs {
  apiKey: string;
  model?: string;
}

export interface AnthropicLauncherArgs {
  accessToken: string;
  model?: string;
}

export interface VertexLauncherArgs {
  apiKey: string;
  model?: string;
}

export interface CliLauncherArgs {
  effort?: ReasoningEffort;
}

/**
 * Construct the launcher for the requested provider.
 * Only the provider actually used is loaded via dynamic import.
 */
export async function createLauncher(
  provider: ProviderName,
  deps: LauncherFactoryDeps,
  model: string | undefined,
  args: Record<string, unknown> = {},
): Promise<ISessionLauncher> {
  switch (provider) {
    case "gemini": {
      const { GeminiSessionLauncher } = await import("./gemini/GeminiSessionLauncher");
      return new GeminiSessionLauncher(deps.runner, deps.clock, model);
    }
    case "copilot": {
      const { CopilotSessionLauncher } = await import("./copilot/CopilotSessionLauncher");
      return new CopilotSessionLauncher(deps.runner, deps.clock, model);
    }
    case "codex": {
      const { CodexSessionLauncher } = await import("./codex/CodexSessionLauncher");
      const cliArgs = args as unknown as CliLauncherArgs;
      return new CodexSessionLauncher(deps.runner, deps.clock, model, deps.logger, cliArgs.effort);
    }
    case "pi": {
      const { PiSessionLauncher } = await import("./pi/PiSessionLauncher");
      const piArgs = args as unknown as PiLauncherArgs;
      return new PiSessionLauncher(deps.runner, deps.clock, {
        provider: piArgs.provider,
        model,
        mode: piArgs.mode,
        thinking: piArgs.thinking,
        sessionDir: piArgs.sessionDir,
        apiToken: piArgs.apiToken,
        providerEnv: piArgs.providerEnv,
        defaultTimeoutMs: piArgs.defaultTimeoutMs,
        defaultIdleTimeoutMs: piArgs.defaultIdleTimeoutMs,
        maxLoggedTextChars: piArgs.maxLoggedTextChars,
        minLoggedTextChars: piArgs.minLoggedTextChars,
      }, deps.logger);
    }
    case "ollama": {
      const { OllamaSessionLauncher } = await import("./ollama/OllamaSessionLauncher");
      const ollamaArgs = args as unknown as OllamaLauncherArgs;
      return new OllamaSessionLauncher(deps.httpClient, deps.clock, ollamaArgs.model, ollamaArgs.baseUrl, ollamaArgs.apiKey);
    }
    case "groq": {
      const { GroqSessionLauncher } = await import("./groq/GroqSessionLauncher");
      const groqArgs = args as unknown as GroqLauncherArgs;
      return new GroqSessionLauncher(deps.httpClient, deps.clock, groqArgs.apiKey, groqArgs.model);
    }
    case "anthropic": {
      const { AnthropicSessionLauncher } = await import("./anthropic/AnthropicSessionLauncher");
      const anthropicArgs = args as unknown as AnthropicLauncherArgs;
      return new AnthropicSessionLauncher(deps.httpClient, deps.clock, anthropicArgs.accessToken, anthropicArgs.model);
    }
    case "vertex": {
      const { VertexSessionLauncher } = await import("./vertex/VertexSessionLauncher");
      const vertexArgs = args as unknown as VertexLauncherArgs;
      return new VertexSessionLauncher(deps.httpClient, deps.clock, vertexArgs.apiKey, vertexArgs.model);
    }
    case "claude":
    default:
      throw new Error(
        `Provider "${provider}" must be constructed directly in createAgentLayer due to sdkQuery dependency.`
      );
  }
}
