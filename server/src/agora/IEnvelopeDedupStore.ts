/**
 * Persistence contract for the Agora envelope deduplication set.
 * Implementations load/save the set of processed envelope IDs so that
 * duplicate-rejection survives process restarts.
 */
export interface IEnvelopeDedupStore {
  /**
   * Load previously-saved envelope IDs.
   * Returns an empty array if none are stored or on any error.
   */
  load(): Promise<string[]>;

  /**
   * Persist the current set of envelope IDs.
   * The store is responsible for applying any size cap.
   * Implementations must not throw — errors should be logged and swallowed.
   */
  save(ids: string[]): Promise<void>;
}
