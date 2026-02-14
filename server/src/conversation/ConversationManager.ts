import { IConversationCompactor } from "./IConversationCompactor";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../substrate/types";
import { SubstrateConfig } from "../substrate/config";
import { PermissionChecker } from "../agents/permissions";
import { AgentRole } from "../agents/types";
import { FileLock } from "../substrate/io/FileLock";

export class ConversationManager {
  private lastCompactionTime: Date | null = null;
  private readonly compactionIntervalMs = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly checker: PermissionChecker,
    private readonly compactor: IConversationCompactor,
    private readonly clock: IClock
  ) {}

  async append(role: AgentRole, entry: string): Promise<void> {
    // Check permissions for append
    this.checker.assertCanAppend(role, SubstrateFileType.CONVERSATION);

    // Check if we need to compact before appending
    await this.checkAndCompactIfNeeded(role);

    // Append the entry with role prefix
    await this.appendWriter.append(SubstrateFileType.CONVERSATION, `[${role}] ${entry}`);
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
   * For testing: reset compaction timer
   */
  resetCompactionTimer(): void {
    this.lastCompactionTime = null;
  }
}
