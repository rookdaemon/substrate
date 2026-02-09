import { appendFileSync, existsSync, renameSync, writeFileSync } from "fs";
import * as path from "path";

export interface ILogger {
  debug(message: string): void;
}

export class InMemoryLogger implements ILogger {
  private entries: string[] = [];

  debug(message: string): void {
    this.entries.push(message);
  }

  getEntries(): string[] {
    return [...this.entries];
  }
}

export class FileLogger implements ILogger {
  private readonly resolvedPath: string;

  constructor(filePath: string) {
    this.resolvedPath = filePath;
    this.rotate();
    this.writeHeader();
  }

  debug(message: string): void {
    const timestamp = new Date().toISOString();
    appendFileSync(this.resolvedPath, `[${timestamp}] ${message}\n`);
  }

  getFilePath(): string {
    return this.resolvedPath;
  }

  private rotate(): void {
    if (!existsSync(this.resolvedPath)) {
      return;
    }

    const dir = path.dirname(this.resolvedPath);
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const rotatedName = `debug.${timestamp}.log`;
    const rotatedPath = path.join(dir, rotatedName);
    renameSync(this.resolvedPath, rotatedPath);
  }

  private writeHeader(): void {
    const timestamp = new Date().toISOString();
    writeFileSync(this.resolvedPath, `[${timestamp}] Session started — log: ${this.resolvedPath}\n`);
  }
}
