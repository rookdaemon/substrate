#!/usr/bin/env node
/**
 * Generate version.json with package version and git hash
 * This runs during build to embed version info into the built code
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(serverDir, "package.json");
const outputPath = path.join(serverDir, "dist", "version.json");

// Read version from package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version || "0.0.0";

// Get git hash (short, 7 chars)
let gitHash = "unknown";
let gitBranch = "unknown";
try {
  gitHash = execSync("git rev-parse --short HEAD", {
    cwd: serverDir,
    encoding: "utf8",
  }).trim();

  gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: serverDir,
    encoding: "utf8",
  }).trim();
} catch (err) {
  // Not a git repo or git not available - use defaults
  console.warn("[generate-version] Could not get git info:", err.message);
}

// Get build timestamp
const buildTime = new Date().toISOString();

const versionInfo = {
  version,
  gitHash,
  gitBranch,
  buildTime,
};

// Ensure dist directory exists
const distDir = path.dirname(outputPath);
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Write version.json
fs.writeFileSync(outputPath, JSON.stringify(versionInfo, null, 2), "utf8");
console.log(`[generate-version] Generated ${outputPath}:`, versionInfo);
