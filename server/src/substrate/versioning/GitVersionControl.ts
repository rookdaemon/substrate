import { IFileSystem } from "../abstractions/IFileSystem";
import { IProcessRunner, ProcessResult } from "../abstractions/IProcessRunner";
import { ILogger } from "../../logging";
import * as path from "node:path";

export interface GitCommitOptions {
  message: string;
  author?: string;
  skipIfClean?: boolean;
}

export interface GitLogEntry {
  hash: string;
  timestamp: string;
  message: string;
  author: string;
}

/**
 * Manages git-based version control for substrate files.
 * Provides automated commits, history, and rollback capabilities.
 */
export class GitVersionControl {
  private readonly gitDir: string;

  constructor(
    private readonly substratePath: string,
    private readonly processRunner: IProcessRunner,
    private readonly fs: IFileSystem,
    private readonly logger: ILogger,
  ) {
    this.gitDir = path.join(substratePath, ".git");
  }

  /**
   * Check if git repository is initialized
   */
  async isInitialized(): Promise<boolean> {
    try {
      const exists = await this.fs.exists(this.gitDir);
      return exists;
    } catch {
      return false;
    }
  }

  /**
   * Initialize git repository if not already initialized
   */
  async initialize(): Promise<void> {
    const initialized = await this.isInitialized();
    if (initialized) {
      this.logger.debug("Git repository already initialized");
      return;
    }

    await this.runGit(["init"]);
    await this.runGit(["config", "user.name", "Bishop Daemon"]);
    await this.runGit(["config", "user.email", "bishop@substrate.local"]);
    this.logger.debug("Git repository initialized at", this.substratePath);
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasChanges(): Promise<boolean> {
    const result = await this.runGit(["status", "--porcelain"]);
    return result.stdout.trim().length > 0;
  }

  /**
   * Get list of changed files
   */
  async getChangedFiles(): Promise<string[]> {
    const result = await this.runGit(["status", "--porcelain"]);
    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);

    return lines
      .map((line) => line.replace(/^..\s*/, "")) // Remove status prefix
      .filter((file) => file.length > 0);
  }

  /**
   * Commit all substrate changes with the given message
   */
  async commitChanges(options: GitCommitOptions): Promise<boolean> {
    if (options.skipIfClean) {
      const hasChanges = await this.hasChanges();
      if (!hasChanges) {
        this.logger.debug("No changes to commit");
        return false;
      }
    }

    // Add all changes
    await this.runGit(["add", "-A"]);

    // Commit
    const args = ["commit", "-m", options.message];
    if (options.author) {
      args.push("--author", options.author);
    }

    const result = await this.runGit(args);
    if (result.success) {
      this.logger.debug("Committed substrate changes:", options.message);
      return true;
    } else {
      // Check if it failed because there were no changes
      if (result.stderr.includes("nothing to commit")) {
        this.logger.debug("No changes to commit");
        return false;
      }
      throw new Error(`Git commit failed: ${result.stderr}`);
    }
  }

  /**
   * Get commit history (most recent first)
   */
  async getHistory(limit: number = 20): Promise<GitLogEntry[]> {
    const result = await this.runGit([
      "log",
      `--max-count=${limit}`,
      "--pretty=format:%H|%aI|%s|%an",
    ]);

    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, timestamp, message, author] = line.split("|");
        return { hash, timestamp, message, author };
      });
  }

  /**
   * Show diff for a specific file
   */
  async getDiff(file?: string): Promise<string> {
    const args = ["diff"];
    if (file) {
      args.push("--", file);
    }
    const result = await this.runGit(args);
    return result.stdout;
  }

  /**
   * Rollback to a specific commit
   */
  async rollback(commitHash: string): Promise<void> {
    // Verify commit exists
    const result = await this.runGit(["cat-file", "-t", commitHash]);
    if (!result.success || result.stdout.trim() !== "commit") {
      throw new Error(`Invalid commit hash: ${commitHash}`);
    }

    // Reset to commit (hard reset - discards all changes)
    await this.runGit(["reset", "--hard", commitHash]);
    this.logger.warn("Rolled back substrate to commit", commitHash);
  }

  /**
   * Create a safety snapshot before potentially destructive operations
   */
  async createSnapshot(label: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const message = `snapshot: ${label} (${timestamp})`;
    
    const hasChanges = await this.hasChanges();
    if (hasChanges) {
      await this.commitChanges({ message, skipIfClean: false });
    }

    // Get current commit hash
    const result = await this.runGit(["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  /**
   * Run git command in substrate directory
   */
  private async runGit(args: string[]): Promise<ProcessResult> {
    return await this.processRunner.run("git", args, {
      cwd: this.substratePath,
    });
  }
}
