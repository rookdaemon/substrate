import { IConversationArchiver } from "./IConversationArchiver";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import * as path from "node:path";

export class ConversationArchiver implements IConversationArchiver {
  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly substratePath: string
  ) {}

  async archive(currentContent: string, linesToKeep: number): Promise<{
    archivedPath?: string;
    remainingContent: string;
    linesArchived: number;
  }> {
    const lines = currentContent.split('\n');
    
    // Separate header lines (starting with #) from content lines
    // Skip empty lines when counting content
    const headerLines: string[] = [];
    const contentLines: string[] = [];
    
    for (const line of lines) {
      if (line.startsWith('#')) {
        headerLines.push(line);
      } else if (line.trim().length > 0) {
        // Only count non-empty lines as content
        contentLines.push(line);
      }
    }

    // If we have fewer content lines than linesToKeep, nothing to archive
    if (contentLines.length <= linesToKeep) {
      return {
        remainingContent: currentContent,
        linesArchived: 0,
      };
    }

    // Split content into old (to archive) and recent (to keep)
    const linesToArchive = contentLines.length - linesToKeep;
    const oldLines = contentLines.slice(0, linesToArchive);
    const recentLines = contentLines.slice(linesToArchive);

    // Create archive directory if it doesn't exist
    const archiveDir = path.join(this.substratePath, 'archive', 'conversation');
    await this.fs.mkdir(archiveDir, { recursive: true });

    // Create date-stamped archive filename
    const timestamp = this.clock.now().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const archiveFilename = `conversation-${timestamp}.md`;
    const archivePath = path.join(archiveDir, archiveFilename);

    // Write archived content
    const archivedContent = [
      '# Archived Conversation',
      '',
      `Archive created: ${this.clock.now().toISOString()}`,
      `Lines archived: ${oldLines.length}`,
      '',
      ...oldLines
    ].join('\n');

    await this.fs.writeFile(archivePath, archivedContent);

    // Build remaining content with headers and recent lines
    const remainingContent = [
      ...headerLines,
      '',
      `## Recent Conversation (Last ${linesToKeep} lines)`,
      '',
      `Previous conversation archived to: ${archiveFilename}`,
      '',
      ...recentLines
    ].join('\n');

    return {
      archivedPath: archivePath,
      remainingContent,
      linesArchived: oldLines.length,
    };
  }
}
