import * as path from "node:path";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { IProcessRunner } from "./agents/claude/IProcessRunner";
import type { IClock } from "./substrate/abstractions/IClock";

export interface BackupArgs {
  command: string;
  args: string[];
}

export function buildBackupArgs(options: {
  configDir: string;
  dataDir: string;
  outputPath: string;
}): BackupArgs {
  return {
    command: "tar",
    args: ["-czf", options.outputPath, options.configDir, options.dataDir],
  };
}

export interface BackupOptions {
  fs: IFileSystem;
  runner: IProcessRunner;
  clock: IClock;
  configDir: string;
  dataDir: string;
  outputDir: string;
}

export interface BackupResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const { fs, runner, clock, configDir, dataDir, outputDir } = options;

  // Determine which directories actually exist
  const dirs: string[] = [];
  if (await fs.exists(configDir)) dirs.push(configDir);
  if (await fs.exists(dataDir)) dirs.push(dataDir);

  if (dirs.length === 0) {
    return { success: false, error: "No directories found to back up" };
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Build timestamped filename
  const timestamp = clock.now().toISOString().replace(/:/g, "-");
  const filename = `rook-wiggums-backup-${timestamp}.tar.gz`;
  const outputPath = path.join(outputDir, filename);

  const result = await runner.run("tar", ["-czf", outputPath, ...dirs]);

  if (result.exitCode !== 0) {
    return { success: false, outputPath, error: result.stderr };
  }

  return { success: true, outputPath };
}
