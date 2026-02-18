import * as path from "node:path";
import { IFileSystem } from "./substrate/abstractions/IFileSystem";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SubstrateConfig } from "./substrate/config";
import { SubstrateInitializer } from "./substrate/initialization/SubstrateInitializer";
import { SubstrateValidator } from "./substrate/initialization/SubstrateValidator";
import { createApplication } from "./loop/createApplication";
import type { AppConfig } from "./config";

export interface StartedServer {
  port: number;
  stop(): Promise<void>;
}

export async function initializeSubstrate(
  fs: IFileSystem,
  substratePath: string
): Promise<void> {
  const config = new SubstrateConfig(substratePath);

  // Initialize substrate files from templates
  const initializer = new SubstrateInitializer(fs, config);
  const initReport = await initializer.initialize();

  if (initReport.created.length > 0) {
    console.log(`Substrate: created ${initReport.created.length} file(s): ${initReport.created.join(", ")}`);
  }

  // Validate substrate
  const validator = new SubstrateValidator(fs, config);
  const validation = await validator.validate();

  if (!validation.valid) {
    const messages: string[] = [];
    for (const missing of validation.missingFiles) {
      messages.push(`Missing: ${missing}`);
    }
    for (const invalid of validation.invalidFiles) {
      messages.push(`Invalid ${invalid.fileType}: ${invalid.errors.join(", ")}`);
    }
    throw new Error(`Substrate validation failed:\n${messages.join("\n")}`);
  }

  console.log("Substrate: validated successfully");
}

export interface StartServerOptions {
  /** Set when supervisor passes --forceStart; server just honors the flag (always auto-start when present). */
  forceStart?: boolean;
}

export async function startServer(config: AppConfig, options?: StartServerOptions): Promise<StartedServer> {
  const fs = new NodeFileSystem();

  // Validate that .mcp.json exists in the working directory (where Claude sessions will run)
  // This is critical for MCP tools to be available to the agent
  const mcpConfigPath = path.join(config.workingDirectory, ".mcp.json");
  const mcpConfigExists = await fs.exists(mcpConfigPath);
  
  if (!mcpConfigExists) {
    console.warn(
      `WARNING: .mcp.json not found in working directory: ${config.workingDirectory}\n` +
      `  Claude Code sessions will not have access to MCP tools (e.g., TinyBus send_message).\n` +
      `  Process cwd: ${process.cwd()}\n` +
      `  Expected location: ${mcpConfigPath}\n` +
      `  Create .mcp.json in the working directory to enable MCP tools.`
    );
  } else {
    console.log(`MCP config found: ${mcpConfigPath}`);
  }

  await initializeSubstrate(fs, config.substratePath);

  const app = await createApplication({
    substratePath: config.substratePath,
    workingDirectory: config.workingDirectory,
    sourceCodePath: config.sourceCodePath,
    model: config.model,
    httpPort: config.port,
    mode: config.mode,
    backupRetentionCount: config.backupRetentionCount,
    superegoAuditInterval: config.superegoAuditInterval,
  });

  console.log(`Debug log: ${app.logPath}`);

  const boundPort = await app.start(config.port, options?.forceStart);
  console.log(`Server listening on port ${boundPort}`);

  return {
    port: boundPort,
    async stop() {
      await app.stop();
    },
  };
}
