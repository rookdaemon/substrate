import * as fs from "node:fs/promises";
import { IFileSystem, FileStat } from "./IFileSystem";

export class NodeFileSystem implements IFileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, "utf-8");
  }

  async appendFile(path: string, content: string): Promise<void> {
    await fs.appendFile(path, content, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(path, options);
  }

  async stat(path: string): Promise<FileStat> {
    const stat = await fs.stat(path);
    return {
      mtimeMs: stat.mtimeMs,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    };
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(path);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fs.copyFile(src, dest);
  }

  async rename(src: string, dest: string): Promise<void> {
    await fs.rename(src, dest);
  }

  async unlink(path: string): Promise<void> {
    await fs.unlink(path);
  }
}
