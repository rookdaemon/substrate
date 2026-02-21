import * as path from "path";
import { IFileSystem } from "./abstractions/IFileSystem";
import { IClock } from "./abstractions/IClock";

export interface SubstrateMeta {
  name: string;
  fullName: string;
  birthdate: string; // ISO 8601 timestamp
}

export class MetaManager {
  private readonly metaPath: string;
  private readonly defaultName: string;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substratePath: string
  ) {
    this.metaPath = path.join(substratePath, "meta.json");
    this.defaultName = path.basename(substratePath);
  }

  async read(): Promise<SubstrateMeta | null> {
    try {
      const content = await this.fs.readFile(this.metaPath);
      return JSON.parse(content) as SubstrateMeta;
    } catch (err) {
      // Return null for missing file (ENOENT) or corrupt JSON
      const isNotFound = err instanceof Error && err.message.includes("ENOENT");
      if (!isNotFound && !(err instanceof SyntaxError)) {
        throw err;
      }
      return null;
    }
  }

  /** Creates meta.json with defaults if it does not already exist. */
  async initialize(): Promise<void> {
    if (await this.fs.exists(this.metaPath)) {
      return;
    }
    await this.fs.mkdir(path.dirname(this.metaPath), { recursive: true });
    const meta: SubstrateMeta = {
      name: this.defaultName,
      fullName: this.defaultName,
      birthdate: this.clock.now().toISOString(),
    };
    await this.fs.writeFile(this.metaPath, JSON.stringify(meta, null, 2));
  }
}
