/**
 * A queue for fire-and-forget async work that must complete
 * before a synchronization barrier (drain).
 *
 * Used to overlap post-execution work (proposals, reconsideration)
 * with the next cycle's dispatch phase.
 */
export class DeferredWorkQueue {
  private pending: Promise<void>[] = [];

  constructor(private readonly onError?: (err: Error, label?: string) => void | Promise<void>) {}

  enqueue(work: Promise<void>, label?: string): void {
    this.pending.push(
      work.catch((err) => {
        if (this.onError) {
          return this.onError(err instanceof Error ? err : new Error(String(err)), label);
        }
      })
    );
  }

  async drain(): Promise<void> {
    const batch = this.pending.splice(0);
    if (batch.length > 0) {
      await Promise.all(batch);
    }
  }

  get size(): number {
    return this.pending.length;
  }
}
