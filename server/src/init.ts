import * as path from "node:path";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { RookConfig } from "./config";
import type { AppPaths } from "./paths";
import { initializeSubstrate } from "./startup";

export async function initWorkspace(
  fs: IFileSystem,
  config: RookConfig,
  appPaths: AppPaths
): Promise<void> {
  // Create working directory
  await fs.mkdir(config.workingDirectory, { recursive: true });

  // Create config directory
  await fs.mkdir(appPaths.config, { recursive: true });

  // Write config.json if it doesn't exist
  const configFilePath = path.join(appPaths.config, "config.json");
  if (!(await fs.exists(configFilePath))) {
    await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));
  }

  // Initialize substrate files
  await initializeSubstrate(fs, config.substratePath);
}
