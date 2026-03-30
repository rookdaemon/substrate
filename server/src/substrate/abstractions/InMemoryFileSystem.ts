import { IFileSystem, FileStat } from "./IFileSystem";

interface FileEntry {
  content: string;
  mtimeMs: number;
}

interface DirEntry {
  mtimeMs: number;
}

export class InMemoryFileSystem implements IFileSystem {
  private files = new Map<string, FileEntry>();
  private dirs = new Set<string>();
  private dirMeta = new Map<string, DirEntry>();
  private nextMtime = Date.now();

  constructor() {
    this.dirs.add("/");
    this.dirMeta.set("/", { mtimeMs: this.nextMtime++ });
  }

  private normalizePath(inputPath: string): string {
    const withSlashes = inputPath.replace(/\\/g, "/");
    if (withSlashes === "") {
      return "/";
    }
    if (withSlashes === "/") {
      return "/";
    }
    return withSlashes.endsWith("/") && withSlashes.length > 1
      ? withSlashes.slice(0, -1)
      : withSlashes;
  }

  async readFile(path: string): Promise<string> {
    const normalizedPath = this.normalizePath(path);
    const entry = this.files.get(normalizedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file '${normalizedPath}'`);
    }
    return entry.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    this.files.set(normalizedPath, { content, mtimeMs: this.nextMtime++ });
  }

  async appendFile(path: string, content: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const existing = this.files.get(normalizedPath);
    if (existing) {
      existing.content += content;
      existing.mtimeMs = this.nextMtime++;
    } else {
      this.files.set(normalizedPath, { content, mtimeMs: this.nextMtime++ });
    }
  }

  async exists(path: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(path);
    return this.files.has(normalizedPath) || this.dirs.has(normalizedPath);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    if (options?.recursive) {
      const parts = normalizedPath.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += "/" + part;
        if (!this.dirs.has(current)) {
          this.dirs.add(current);
          this.dirMeta.set(current, { mtimeMs: this.nextMtime++ });
        }
      }
    } else {
      const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf("/")) || "/";
      if (!this.dirs.has(parent)) {
        throw new Error(`ENOENT: no such directory '${parent}'`);
      }
      this.dirs.add(normalizedPath);
      this.dirMeta.set(normalizedPath, { mtimeMs: this.nextMtime++ });
    }
  }

  async stat(path: string): Promise<FileStat> {
    const normalizedPath = this.normalizePath(path);
    const file = this.files.get(normalizedPath);
    if (file) {
      return {
        mtimeMs: file.mtimeMs,
        isFile: true,
        isDirectory: false,
        size: Buffer.byteLength(file.content, "utf-8"),
      };
    }
    if (this.dirs.has(normalizedPath)) {
      const meta = this.dirMeta.get(normalizedPath)!;
      return { mtimeMs: meta.mtimeMs, isFile: false, isDirectory: true, size: 0 };
    }
    throw new Error(`ENOENT: no such file or directory '${normalizedPath}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const normalizedPath = this.normalizePath(path);
    if (!this.dirs.has(normalizedPath)) {
      throw new Error(`ENOENT: no such directory '${normalizedPath}'`);
    }
    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    const entries: string[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
    }
    for (const dirPath of this.dirs) {
      if (dirPath.startsWith(prefix) && dirPath !== normalizedPath) {
        const rest = dirPath.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
    }
    return entries;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const normalizedSrc = this.normalizePath(src);
    const normalizedDest = this.normalizePath(dest);
    const entry = this.files.get(normalizedSrc);
    if (!entry) {
      throw new Error(`ENOENT: no such file '${normalizedSrc}'`);
    }
    this.files.set(normalizedDest, { content: entry.content, mtimeMs: this.nextMtime++ });
  }

  async rename(src: string, dest: string): Promise<void> {
    const normalizedSrc = this.normalizePath(src);
    const normalizedDest = this.normalizePath(dest);
    const entry = this.files.get(normalizedSrc);
    if (!entry) {
      throw new Error(`ENOENT: no such file '${normalizedSrc}'`);
    }
    this.files.set(normalizedDest, { content: entry.content, mtimeMs: this.nextMtime++ });
    this.files.delete(normalizedSrc);
  }

  async unlink(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    if (!this.files.has(normalizedPath)) {
      throw new Error(`ENOENT: no such file '${normalizedPath}'`);
    }
    this.files.delete(normalizedPath);
  }
}
