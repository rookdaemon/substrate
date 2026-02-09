import * as path from "node:path";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { AppPaths } from "./paths";

export interface RookConfig {
  substratePath: string;
  workingDirectory: string;
  port: number;
  model: string;
}

export interface ResolveConfigOptions {
  appPaths: AppPaths;
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function resolveConfig(
  fs: IFileSystem,
  options: ResolveConfigOptions
): Promise<RookConfig> {
  const { appPaths, env = {} } = options;

  const defaults: RookConfig = {
    substratePath: path.join(appPaths.data, "substrate"),
    workingDirectory: appPaths.data,
    port: 3000,
    model: "sonnet",
  };

  let fileConfig: Partial<RookConfig> = {};

  if (options.configPath) {
    if (!(await fs.exists(options.configPath))) {
      throw new Error(`Config file not found: ${options.configPath}`);
    }
    const raw = await fs.readFile(options.configPath);
    fileConfig = JSON.parse(raw) as Partial<RookConfig>;
  } else {
    // Try CWD config.json
    const cwdConfig = options.cwd ? path.join(options.cwd, "config.json") : undefined;
    if (cwdConfig && await fs.exists(cwdConfig)) {
      const raw = await fs.readFile(cwdConfig);
      fileConfig = JSON.parse(raw) as Partial<RookConfig>;
    } else {
      // Try config-dir config.json
      const configDirFile = path.join(appPaths.config, "config.json");
      if (await fs.exists(configDirFile)) {
        const raw = await fs.readFile(configDirFile);
        fileConfig = JSON.parse(raw) as Partial<RookConfig>;
      }
    }
  }

  const merged: RookConfig = {
    substratePath: fileConfig.substratePath ?? defaults.substratePath,
    workingDirectory: fileConfig.workingDirectory ?? defaults.workingDirectory,
    port: fileConfig.port ?? defaults.port,
    model: fileConfig.model ?? defaults.model,
  };

  // Env vars override everything
  if (env["SUBSTRATE_PATH"]) {
    merged.substratePath = env["SUBSTRATE_PATH"];
  }
  if (env["PORT"]) {
    merged.port = parseInt(env["PORT"], 10);
  }

  return merged;
}
