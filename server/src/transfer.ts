import type { IProcessRunner } from "./agents/claude/IProcessRunner";

const DEFAULT_REMOTE_SUBSTRATE = ".local/share/substrate";
const DEFAULT_REMOTE_CONFIG = ".config/substrate";

export interface TransferOptions {
  runner: IProcessRunner;
  sourceSubstrate: string;
  destSubstrate: string;
  sourceConfig?: string;
  destConfig?: string;
  identity?: string;
}

export interface TransferResult {
  success: boolean;
  error?: string;
}

/**
 * If dest is `user@host` (no colon/path), appends the default substrate path.
 * If dest is `user@host:/path` or a local path, returns unchanged.
 */
export function resolveRemotePath(dest: string): string {
  // Local path — no @
  if (!dest.includes("@")) return dest;
  // Already has explicit path — has colon after @
  if (dest.includes(":")) return dest;
  // Remote host without path — append default
  return `${dest}:${DEFAULT_REMOTE_SUBSTRATE}`;
}

/**
 * Extracts user@host from a remote dest, or null for local paths.
 */
export function extractHost(dest: string): string | null {
  if (!dest.includes("@")) return null;
  const colonIdx = dest.indexOf(":");
  return colonIdx >= 0 ? dest.substring(0, colonIdx) : dest;
}

/**
 * Returns the default remote config path for a dest, or null for local paths.
 * Always uses the host portion — ignores any explicit path in dest.
 */
export function resolveRemoteConfigPath(dest: string): string | null {
  const host = extractHost(dest);
  if (!host) return null;
  return `${host}:${DEFAULT_REMOTE_CONFIG}`;
}

function buildRsyncArgs(source: string, dest: string, identity?: string): string[] {
  const args = ["-a", "--mkpath"];
  if (identity) {
    args.push("-e", `ssh -i ${identity}`);
  }
  args.push(`${source}/`, `${dest}/`);
  return args;
}

export async function transfer(options: TransferOptions): Promise<TransferResult> {
  const { runner, sourceSubstrate, destSubstrate, identity } = options;

  const substrateArgs = buildRsyncArgs(sourceSubstrate, destSubstrate, identity);
  const substrateResult = await runner.run("rsync", substrateArgs);

  if (substrateResult.exitCode !== 0) {
    return { success: false, error: substrateResult.stderr };
  }

  if (options.sourceConfig && options.destConfig) {
    const configArgs = buildRsyncArgs(options.sourceConfig, options.destConfig, identity);
    const configResult = await runner.run("rsync", configArgs);

    if (configResult.exitCode !== 0) {
      return { success: false, error: configResult.stderr };
    }
  }

  return { success: true };
}
