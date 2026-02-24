import { createHash } from "node:crypto";
import { IFileSystem } from "../abstractions/IFileSystem";
import { SubstrateConfig } from "../config";
import { SubstrateFileType } from "../types";

export interface SubstrateFileMeta {
  fileType: SubstrateFileType;
  filePath: string;
  lastModified: number;
  contentHash: string;
}

export interface SubstrateFileContent {
  meta: SubstrateFileMeta;
  rawMarkdown: string;
}

export interface CacheMetrics {
  cacheHits: number;
  cacheMisses: number;
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
  contentHash: string;
}

export class SubstrateFileReader {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly enableCache = true
  ) {}

  async read(fileType: SubstrateFileType): Promise<SubstrateFileContent> {
    const filePath = this.config.getFilePath(fileType);

    if (this.enableCache) {
      const stat = await this.fs.stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        this.cacheHits++;
        return {
          meta: { fileType, filePath, lastModified: stat.mtimeMs, contentHash: cached.contentHash },
          rawMarkdown: cached.content,
        };
      }
      const rawMarkdown = await this.fs.readFile(filePath);
      const contentHash = createHash("sha256").update(rawMarkdown).digest("hex");
      this.cache.set(filePath, { content: rawMarkdown, mtimeMs: stat.mtimeMs, contentHash });
      this.cacheMisses++;
      return {
        meta: { fileType, filePath, lastModified: stat.mtimeMs, contentHash },
        rawMarkdown,
      };
    }

    const rawMarkdown = await this.fs.readFile(filePath);
    const stat = await this.fs.stat(filePath);
    const contentHash = createHash("sha256").update(rawMarkdown).digest("hex");
    return {
      meta: { fileType, filePath, lastModified: stat.mtimeMs, contentHash },
      rawMarkdown,
    };
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  getMetrics(): CacheMetrics {
    return { cacheHits: this.cacheHits, cacheMisses: this.cacheMisses };
  }
}
