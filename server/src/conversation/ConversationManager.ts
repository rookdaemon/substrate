import { IConversationCompactor } from "./IConversationCompactor";
import { IConversationArchiver } from "./IConversationArchiver";
import { IConversationManager } from "./IConversationManager";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../substrate/types";
import { SubstrateConfig } from "../substrate/config";
import { PermissionChecker } from "../agents/permissions";
import { AgentRole } from "../agents/types";
import { FileLock } from "../substrate/io/FileLock";

export interface ConversationArchiveConfig {
  enabled: boolean;
  linesToKeep: number; // Number of recent lines to keep (default: 100)
  sizeThreshold: number; // Archive when content exceeds N lines (default: 200)
  timeThresholdMs?: number; // Optional: archive after N ms (e.g., weekly)
}

export class ConversationManager implements IConversationManager {
  private lastCompactionTime: Date | null = null;
  private lastArchiveTime: Date | null = null;
  private readonly compactionIntervalMs = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly checker: PermissionChecker,
    private readonly compactor: IConversationCompactor,
    private readonly clock: IClock,
    private readonly archiver?: IConversationArchiver,
    private readonly archiveConfig?: ConversationArchiveConfig
  ) {}

  async append(role: AgentRole, entry: string): Promise<void> {
    // Check permissions for append
    this.checker.assertCanAppend(role, SubstrateFileType.CONVERSATION);

    // Check if we need to archive before appending (if archiving enabled)
    if (this.archiver && this.archiveConfig?.enabled) {
      await this.checkAndArchiveIfNeeded();
    }

    // Check if we need to compact before appending (legacy summarization)
    await this.checkAndCompactIfNeeded(role);

    // Append the entry with role prefix
    await this.appendWriter.append(SubstrateFileType.CONVERSATION, `[${role}] ${entry}`);
  }

  private async checkAndArchiveIfNeeded(): Promise<void> {
    if (!this.archiver || !this.archiveConfig?.enabled) {
      return;
    }

    const now = this.clock.now();

    // Initialize last archive time on first check
    if (this.lastArchiveTime === null) {
      this.lastArchiveTime = now;
    }

    // Read current conversation to check size
    const content = await this.reader.read(SubstrateFileType.CONVERSATION);
    const currentContent = content.rawMarkdown;
    const contentLines = currentContent.split('\n').filter(line => 
      line.trim().length > 0 && !line.startsWith('#')
    );

    // Check size-based trigger
    const exceedsSizeThreshold = contentLines.length >= this.archiveConfig.sizeThreshold;

    // Check time-based trigger (if configured)
    let exceedsTimeThreshold = false;
    if (this.archiveConfig.timeThresholdMs) {
      const timeSinceLastArchive = now.getTime() - this.lastArchiveTime.getTime();
      exceedsTimeThreshold = timeSinceLastArchive >= this.archiveConfig.timeThresholdMs;
    }

    // Trigger archive if either threshold is exceeded
    if (exceedsSizeThreshold || exceedsTimeThreshold) {
      await this.performArchive();
      this.lastArchiveTime = now;
    }
  }

  private async performArchive(): Promise<void> {
    if (!this.archiver || !this.archiveConfig) {
      return;
    }

    // Read current conversation
    const content = await this.reader.read(SubstrateFileType.CONVERSATION);
    const currentContent = content.rawMarkdown;

    // Archive old content
    const result = await this.archiver.archive(currentContent, this.archiveConfig.linesToKeep);

    // Only write back if something was archived
    if (result.linesArchived > 0) {
      const release = await this.lock.acquire(SubstrateFileType.CONVERSATION);
      try {
        const filePath = this.config.getFilePath(SubstrateFileType.CONVERSATION);
        await this.fs.writeFile(filePath, result.remainingContent);
      } finally {
        release();
      }
    }
  }

  private async checkAndCompactIfNeeded(role: AgentRole): Promise<void> {
    const now = this.clock.now();

    // If this is the first append or an hour has passed since last compaction
    if (this.lastCompactionTime === null) {
      this.lastCompactionTime = now;
      return;
    }

    const timeSinceLastCompaction = now.getTime() - this.lastCompactionTime.getTime();
    if (timeSinceLastCompaction >= this.compactionIntervalMs) {
      await this.performCompaction(role);
      this.lastCompactionTime = now;
    }
  }

  private async performCompaction(_role: AgentRole): Promise<void> {
    // NOTE: Compaction is a privileged operation that directly overwrites the file
    // without going through permission checks or SubstrateFileWriter.
    // This is intentional since compaction is a maintenance operation.

    // Read current conversation
    const content = await this.reader.read(SubstrateFileType.CONVERSATION);
    const currentContent = content.rawMarkdown;

    // Calculate one hour ago timestamp
    const oneHourAgo = new Date(this.clock.now().getTime() - this.compactionIntervalMs);
    const oneHourAgoISO = oneHourAgo.toISOString();

    // Compact the conversation
    const compactedContent = await this.compactor.compact(currentContent, oneHourAgoISO);

    // Write the compacted conversation back (directly to filesystem, bypassing FileWriter)
    const release = await this.lock.acquire(SubstrateFileType.CONVERSATION);
    try {
      const filePath = this.config.getFilePath(SubstrateFileType.CONVERSATION);
      await this.fs.writeFile(filePath, compactedContent);
    } finally {
      release();
    }
  }

  /**
   * For testing: manually trigger compaction
   */
  async forceCompaction(role: AgentRole): Promise<void> {
    await this.performCompaction(role);
    this.lastCompactionTime = this.clock.now();
  }

  /**
   * Manually trigger archive (programmatically invokable)
   */
  async forceArchive(): Promise<{ success: boolean; linesArchived: number; archivedPath?: string }> {
    if (!this.archiver || !this.archiveConfig) {
      return { success: false, linesArchived: 0 };
    }

    const content = await this.reader.read(SubstrateFileType.CONVERSATION);
    const currentContent = content.rawMarkdown;

    const result = await this.archiver.archive(currentContent, this.archiveConfig.linesToKeep);

    if (result.linesArchived > 0) {
      const release = await this.lock.acquire(SubstrateFileType.CONVERSATION);
      try {
        const filePath = this.config.getFilePath(SubstrateFileType.CONVERSATION);
        await this.fs.writeFile(filePath, result.remainingContent);
      } finally {
        release();
      }
    }

    this.lastArchiveTime = this.clock.now();

    return {
      success: true,
      linesArchived: result.linesArchived,
      archivedPath: result.archivedPath,
    };
  }

  /**
   * For testing: reset compaction timer
   */
  resetCompactionTimer(): void {
    this.lastCompactionTime = null;
  }

  /**
   * For testing: reset archive timer
   */
  resetArchiveTimer(): void {
    this.lastArchiveTime = null;
  }

  /**
   * Get last maintenance timestamp (compaction or archive, whichever is more recent).
   * Returns null if no maintenance has occurred since process start.
   */
  getLastMaintenanceTime(): Date | null {
    // Return the most recent of compaction or archive time
    if (!this.lastCompactionTime && !this.lastArchiveTime) {
      return null;
    }
    if (!this.lastCompactionTime) {
      return this.lastArchiveTime;
    }
    if (!this.lastArchiveTime) {
      return this.lastCompactionTime;
    }
    return this.lastCompactionTime > this.lastArchiveTime 
      ? this.lastCompactionTime 
      : this.lastArchiveTime;
  }
}
