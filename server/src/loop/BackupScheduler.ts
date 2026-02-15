import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IProcessRunner } from "../agents/claude/IProcessRunner";
import { ILogger } from "../logging";
import { createBackup } from "../backup";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface BackupSchedulerConfig {
  substratePath: string;
  backupDir: string;
  backupIntervalMs: number; // e.g., 86400000 for daily (24 hours)
  retentionCount: number; // number of backups to keep
  verifyBackups: boolean; // whether to verify backup integrity
  stateFilePath?: string; // path to persist last backup timestamp
}

export interface BackupVerificationResult {
  valid: boolean;
  checksum?: string;
  sizeBytes?: number;
  error?: string;
}

export interface ScheduledBackupResult {
  success: boolean;
  backupPath?: string;
  verification?: BackupVerificationResult;
  error?: string;
  timestamp: string;
}

export class BackupScheduler {
  private lastBackupTime: Date | null = null;
  private backupCount = 0;
  private stateLoaded = false;

  constructor(
    private readonly fs: IFileSystem,
    private readonly runner: IProcessRunner,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: BackupSchedulerConfig
  ) {}

  /**
   * Check if a backup should run based on interval
   */
  async shouldRunBackup(): Promise<boolean> {
    // Ensure state is loaded from disk on first call
    if (!this.stateLoaded) {
      await this.ensureStateLoaded();
    }

    if (!this.lastBackupTime) {
      return true; // First backup
    }

    const elapsed = this.clock.now().getTime() - this.lastBackupTime.getTime();
    return elapsed >= this.config.backupIntervalMs;
  }

  /**
   * Execute a scheduled backup with verification
   */
  async runBackup(): Promise<ScheduledBackupResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("BackupScheduler: starting scheduled backup");

    try {
      // Create backup
      const backupResult = await createBackup({
        fs: this.fs,
        runner: this.runner,
        clock: this.clock,
        substratePath: this.config.substratePath,
        outputDir: this.config.backupDir,
      });

      if (!backupResult.success) {
        this.logger.debug(`BackupScheduler: backup failed — ${backupResult.error}`);
        return {
          success: false,
          error: backupResult.error,
          timestamp,
        };
      }

      this.logger.debug(`BackupScheduler: backup created at ${backupResult.outputPath}`);
      this.lastBackupTime = this.clock.now();
      this.backupCount++;
      this.stateLoaded = true; // Mark state as loaded since we just updated it

      // Persist state after successful backup
      await this.persistLastBackupTime(this.lastBackupTime);

      // Verify backup if enabled
      let verification: BackupVerificationResult | undefined;
      if (this.config.verifyBackups && backupResult.outputPath) {
        verification = await this.verifyBackup(backupResult.outputPath);
        if (!verification.valid) {
          this.logger.debug(`BackupScheduler: verification failed — ${verification.error}`);
          return {
            success: false,
            backupPath: backupResult.outputPath,
            verification,
            error: `Backup verification failed: ${verification.error}`,
            timestamp,
          };
        }
        this.logger.debug(`BackupScheduler: verification passed (checksum: ${verification.checksum})`);
      }

      // Clean up old backups
      await this.cleanupOldBackups();

      return {
        success: true,
        backupPath: backupResult.outputPath,
        verification,
        timestamp,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`BackupScheduler: unexpected error — ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp,
      };
    }
  }

  /**
   * Verify backup integrity using checksum and tar test
   */
  async verifyBackup(backupPath: string): Promise<BackupVerificationResult> {
    try {
      // Check file exists
      if (!(await this.fs.exists(backupPath))) {
        return { valid: false, error: "Backup file not found" };
      }

      // Get file size
      const stats = await this.fs.stat(backupPath);
      const sizeBytes = stats.size;

      if (sizeBytes === 0) {
        return { valid: false, sizeBytes, error: "Backup file is empty" };
      }

      // Compute SHA-256 checksum
      const fileContent = await this.fs.readFile(backupPath);
      const checksum = crypto.createHash("sha256").update(fileContent).digest("hex");

      // Verify tar archive integrity
      const tarResult = await this.runner.run("tar", ["-tzf", backupPath]);
      if (tarResult.exitCode !== 0) {
        return {
          valid: false,
          checksum,
          sizeBytes,
          error: `tar verification failed: ${tarResult.stderr}`,
        };
      }

      // Count files in archive
      const fileList = tarResult.stdout.trim().split("\n").filter((line) => line.length > 0);
      if (fileList.length === 0) {
        return {
          valid: false,
          checksum,
          sizeBytes,
          error: "Backup archive is empty",
        };
      }

      this.logger.debug(`BackupScheduler: verified ${fileList.length} files in archive`);

      return {
        valid: true,
        checksum,
        sizeBytes,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: errorMsg };
    }
  }

  /**
   * Remove old backups beyond retention count
   */
  async cleanupOldBackups(): Promise<void> {
    try {
      if (!(await this.fs.exists(this.config.backupDir))) {
        return;
      }

      const entries = await this.fs.readdir(this.config.backupDir);
      const backups = entries
        .filter((f) => f.startsWith("substrate-backup-") && f.endsWith(".tar.gz"))
        .sort(); // Lexicographic sort works for ISO timestamps

      if (backups.length <= this.config.retentionCount) {
        return;
      }

      const toDelete = backups.slice(0, backups.length - this.config.retentionCount);
      this.logger.debug(`BackupScheduler: cleaning up ${toDelete.length} old backup(s)`);

      for (const filename of toDelete) {
        const filePath = path.join(this.config.backupDir, filename);
        await this.fs.unlink(filePath);
        this.logger.debug(`BackupScheduler: deleted old backup ${filename}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`BackupScheduler: cleanup error — ${errorMsg}`);
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    lastBackupTime: Date | null;
    backupCount: number;
    nextBackupDue: Date | null;
  } {
    const nextBackupDue = this.lastBackupTime
      ? new Date(this.lastBackupTime.getTime() + this.config.backupIntervalMs)
      : this.clock.now();

    return {
      lastBackupTime: this.lastBackupTime,
      backupCount: this.backupCount,
      nextBackupDue,
    };
  }

  /**
   * Ensure state is loaded from disk
   */
  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }

    this.lastBackupTime = await this.loadLastBackupTime();
    this.stateLoaded = true;
  }

  /**
   * Load last backup time from state file
   */
  private async loadLastBackupTime(): Promise<Date | null> {
    if (!this.config.stateFilePath) {
      return null;
    }

    try {
      const exists = await this.fs.exists(this.config.stateFilePath);
      if (!exists) {
        return null;
      }

      const content = await this.fs.readFile(this.config.stateFilePath);
      const date = new Date(content.trim());
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  /**
   * Persist last backup time to state file
   */
  private async persistLastBackupTime(time: Date): Promise<void> {
    if (!this.config.stateFilePath) {
      return;
    }

    try {
      const dir = path.dirname(this.config.stateFilePath);
      await this.fs.mkdir(dir, { recursive: true });
      await this.fs.writeFile(this.config.stateFilePath, time.toISOString());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`BackupScheduler: failed to persist state — ${errorMsg}`);
    }
  }
}
