export interface IConversationCompactor {
  /**
   * Compacts the CONVERSATION.md file by summarizing older conversations
   * while retaining detailed information from the last hour.
   * 
   * @param currentContent - The current content of CONVERSATION.md
   * @param oneHourAgo - ISO timestamp representing one hour ago
   * @returns The compacted conversation content
   */
  compact(currentContent: string, oneHourAgo: string): Promise<string>;
}
