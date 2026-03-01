#!/usr/bin/env node
/**
 * Git operations for substrate versioning
 * Usage: npx tsx src/substrate-git.ts <command> [options]
 */

import * as path from "node:path";
import { GitVersionControl } from "./substrate/versioning/GitVersionControl";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { NodeProcessRunner } from "./substrate/abstractions/NodeProcessRunner";
import { FileLogger } from "./logging";
import { getAppPaths } from "./paths";
import { NodeEnvironment } from "./substrate/abstractions/NodeEnvironment";
import { resolveConfig } from "./config";

interface Args {
  command: "history" | "rollback" | "diff" | "snapshot" | "status";
  limit?: number;
  commitHash?: string;
  file?: string;
  label?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let command: Args["command"] = "history";
  let limit: number | undefined;
  let commitHash: string | undefined;
  let file: string | undefined;
  let label: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "history" || arg === "rollback" || arg === "diff" || arg === "snapshot" || arg === "status") {
      command = arg;
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
    } else if (arg === "--commit" && i + 1 < args.length) {
      commitHash = args[++i];
    } else if (arg === "--file" && i + 1 < args.length) {
      file = args[++i];
    } else if (arg === "--label" && i + 1 < args.length) {
      label = args[++i];
    }
  }

  return { command, limit, commitHash, file, label };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const env = new NodeEnvironment();
  const appPaths = getAppPaths({ env });
  const config = await resolveConfig(env, { appPaths, cwd: process.cwd() });

  const fs = new NodeFileSystem();
  const runner = new NodeProcessRunner();
  const logger = new FileLogger(path.join(config.substratePath, "..", "git-cli.log"));
  
  const git = new GitVersionControl(config.substratePath, runner, fs, logger);

  const initialized = await git.isInitialized();
  if (!initialized && args.command !== "status") {
    console.error("Git repository not initialized in substrate directory");
    console.error(`Path: ${config.substratePath}`);
    console.error("Run: cd ~/.local/share/substrate && git init");
    process.exit(1);
  }

  try {
    if (args.command === "history") {
      const limit = args.limit ?? 20;
      const commits = await git.getHistory(limit);
      if (commits.length === 0) {
        console.log("No commits yet");
      } else {
        console.log(`\n📜 Substrate Git History (last ${limit} commits):\n`);
        commits.forEach((commit) => {
          const shortHash = commit.hash.substring(0, 8);
          const date = new Date(commit.timestamp).toLocaleString();
          console.log(`${shortHash}  ${date}  ${commit.author}`);
          console.log(`  ${commit.message}\n`);
        });
      }
    } else if (args.command === "status") {
      if (!initialized) {
        console.log("❌ Git not initialized");
        console.log(`   Path: ${config.substratePath}`);
        process.exit(1);
      }
      const hasChanges = await git.hasChanges();
      if (hasChanges) {
        const changedFiles = await git.getChangedFiles();
        console.log(`\n⚠️  Uncommitted changes (${changedFiles.length} files):\n`);
        changedFiles.forEach((file) => console.log(`  - ${file}`));
        console.log();
      } else {
        console.log("✅ No uncommitted changes");
      }
    } else if (args.command === "diff") {
      const diff = await git.getDiff(args.file);
      if (diff.trim()) {
        console.log(diff);
      } else {
        console.log("No changes to display");
      }
    } else if (args.command === "snapshot") {
      const label = args.label ?? "manual-snapshot";
      const commitHash = await git.createSnapshot(label);
      console.log(`✅ Snapshot created: ${label}`);
      console.log(`   Commit: ${commitHash.substring(0, 8)}`);
    } else if (args.command === "rollback") {
      if (!args.commitHash) {
        console.error("Error: --commit <hash> required for rollback");
        console.error("Usage: substrate-git rollback --commit <hash>");
        console.error("Tip: Use 'substrate-git history' to see available commits");
        process.exit(1);
      }
      console.log(`⚠️  Rolling back to ${args.commitHash}`);
      console.log("   This will DISCARD all uncommitted changes!");
      console.log("   Press Ctrl+C within 5 seconds to cancel...");
      
      await new Promise((resolve) => setTimeout(resolve, 5000));
      
      await git.rollback(args.commitHash);
      console.log(`✅ Rolled back to ${args.commitHash.substring(0, 8)}`);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Skip main() in test runners
if (!process.env.JEST_WORKER_ID) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
