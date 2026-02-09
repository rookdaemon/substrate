import { IFileSystem } from "./substrate/abstractions/IFileSystem";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SubstrateConfig } from "./substrate/config";
import { SubstrateInitializer } from "./substrate/initialization/SubstrateInitializer";
import { SubstrateValidator } from "./substrate/initialization/SubstrateValidator";
import { createApplication } from "./loop/createApplication";
import type { RookConfig } from "./config";

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

export async function startServer(config: RookConfig): Promise<StartedServer> {
  const fs = new NodeFileSystem();

  await initializeSubstrate(fs, config.substratePath);

  const app = createApplication({
    substratePath: config.substratePath,
    workingDirectory: config.workingDirectory,
    httpPort: config.port,
  });

  console.log(`Debug log: ${app.logPath}`);

  const boundPort = await app.start(config.port);
  console.log(`Server listening on port ${boundPort}`);

  return {
    port: boundPort,
    async stop() {
      await app.stop();
    },
  };
}
