import * as fs from "node:fs/promises";
import * as os from "node:os";
import { IFileSystem, FileStat } from "./IFileSystem";

/**
 * Expand tilde (~) in paths to the user's home directory.
 * Node.js fs methods don't automatically expand ~, so we do it explicitly.
 */
function expandTilde(filepath: string): string {
  if (filepath === "~") {
    return os.homedir();
  }
  if (filepath.startsWith("~/")) {
    return os.homedir() + filepath.slice(1);
  }
  return filepath;
}

export class NodeFileSystem implements IFileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(expandTilde(path), "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(expandTilde(path), content, "utf-8");
  }

  async appendFile(path: string, content: string): Promise<void> {
    await fs.appendFile(expandTilde(path), content, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(expandTilde(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(expandTilde(path), options);
  }

  async stat(path: string): Promise<FileStat> {
    const stat = await fs.stat(expandTilde(path));
    return {
      mtimeMs: stat.mtimeMs,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    };
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(expandTilde(path));
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fs.copyFile(expandTilde(src), expandTilde(dest));
  }

  async unlink(path: string): Promise<void> {
    await fs.unlink(expandTilde(path));
  }
}
