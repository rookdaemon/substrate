export interface IConversationArchiver {
  /**
   * Archives old conversation content to a date-stamped file
   * and returns the remaining recent content.
   * 
   * @param currentContent - The current content of CONVERSATION.md
   * @param linesToKeep - Number of recent lines to keep in the main file
   * @returns Object with archived content path and remaining content
   */
  archive(currentContent: string, linesToKeep: number): Promise<{
    archivedPath?: string;
    remainingContent: string;
    linesArchived: number;
  }>;
}
