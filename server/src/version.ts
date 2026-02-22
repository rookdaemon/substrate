/**
 * Version information module
 * Reads version.json generated at build time
 */

import * as fs from "node:fs";
import * as path from "node:path";

declare const __dirname: string;
const SERVER_DIR =
  typeof __dirname !== "undefined" ? path.resolve(__dirname, "..") : process.cwd();

export interface VersionInfo {
  version: string;
  gitHash: string;
  gitBranch: string;
  buildTime: string;
}

let cachedVersion: VersionInfo | null = null;

/**
 * Get version information
 * Reads from dist/version.json generated at build time
 */
export function getVersionInfo(): VersionInfo {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    // In production, version.json is in dist/ relative to the compiled code
    // When running from source (tsx), we need to look in dist/ relative to src/
    
    // Try multiple possible locations
    const possiblePaths = [
      path.join(SERVER_DIR, "dist", "version.json"), // ESM bundle or CJS
      path.join(SERVER_DIR, "..", "dist", "version.json"), // Alternative
      path.join(process.cwd(), "dist", "version.json"), // CWD-based
    ];

    for (const versionPath of possiblePaths) {
      if (fs.existsSync(versionPath)) {
        const content = fs.readFileSync(versionPath, 'utf8');
        cachedVersion = JSON.parse(content) as VersionInfo;
        return cachedVersion;
      }
    }
  } catch {
    // Ignore errors, will use fallback
  }

  // Fallback if version.json not found or error occurred
  cachedVersion = {
    version: '0.0.0-dev',
    gitHash: 'unknown',
    gitBranch: 'unknown',
    buildTime: new Date().toISOString(),
  };
  return cachedVersion;
}

/**
 * Get version string (for backwards compatibility)
 */
export function getVersion(): string {
  return getVersionInfo().version;
}
