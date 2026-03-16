/**
 * Writer that appends EGO narration and task execution summaries to the cycle
 * log instead of CONVERSATION.md.  CONVERSATION.md is reserved for inbound
 * messages and Agora traffic only (D-01 fix).
 */
export interface ICycleLogWriter {
  /**
   * Append one entry to the cycle log.
   * @param role  Agent role label, e.g. "EGO" or "SUBCONSCIOUS".
   * @param text  The narration / summary text produced by that role.
   */
  write(role: string, text: string): Promise<void>;
}
