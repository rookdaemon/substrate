export type Release = () => void;

export class FileLock {
  private chains = new Map<string, Promise<void>>();

  async acquire(fileType: string): Promise<Release> {
    const current = this.chains.get(fileType) ?? Promise.resolve();

    let release: Release;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.chains.set(fileType, next);

    await current;
    return release!;
  }
}
