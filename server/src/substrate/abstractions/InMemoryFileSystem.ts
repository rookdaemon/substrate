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

  async readFile(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (!entry) {
      throw new Error(`ENOENT: no such file '${path}'`);
    }
    return entry.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, { content, mtimeMs: this.nextMtime++ });
  }

  async appendFile(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    if (existing) {
      existing.content += content;
      existing.mtimeMs = this.nextMtime++;
    } else {
      this.files.set(path, { content, mtimeMs: this.nextMtime++ });
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += "/" + part;
        if (!this.dirs.has(current)) {
          this.dirs.add(current);
          this.dirMeta.set(current, { mtimeMs: this.nextMtime++ });
        }
      }
    } else {
      const parent = path.substring(0, path.lastIndexOf("/")) || "/";
      if (!this.dirs.has(parent)) {
        throw new Error(`ENOENT: no such directory '${parent}'`);
      }
      this.dirs.add(path);
      this.dirMeta.set(path, { mtimeMs: this.nextMtime++ });
    }
  }

  async stat(path: string): Promise<FileStat> {
    const file = this.files.get(path);
    if (file) {
      return {
        mtimeMs: file.mtimeMs,
        isFile: true,
        isDirectory: false,
        size: Buffer.byteLength(file.content, "utf-8"),
      };
    }
    if (this.dirs.has(path)) {
      const meta = this.dirMeta.get(path)!;
      return { mtimeMs: meta.mtimeMs, isFile: false, isDirectory: true, size: 0 };
    }
    throw new Error(`ENOENT: no such file or directory '${path}'`);
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) {
      throw new Error(`ENOENT: no such directory '${path}'`);
    }
    const prefix = path === "/" ? "/" : path + "/";
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
      if (dirPath.startsWith(prefix) && dirPath !== path) {
        const rest = dirPath.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
    }
    return entries;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const entry = this.files.get(src);
    if (!entry) {
      throw new Error(`ENOENT: no such file '${src}'`);
    }
    this.files.set(dest, { content: entry.content, mtimeMs: this.nextMtime++ });
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error(`ENOENT: no such file '${path}'`);
    }
    this.files.delete(path);
  }
}
