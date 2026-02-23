import { appendFileSync, existsSync, renameSync, statSync } from "fs";
import * as path from "path";

/** Controls how much detail is written to debug.log.
 *  "info"  — operational events only (envelope ID, sender, lifecycle).
 *  "debug" — also includes full payloads and session content (verbose). */
export type LogLevel = "info" | "debug";

export interface ILogger {
  /** Always written. Use for operational events: envelope ID, sender, lifecycle. */
  debug(message: string): void;
  /** Only written when logLevel is "debug". Use for payloads and session content. */
  verbose(message: string): void;
}

export class InMemoryLogger implements ILogger {
  private entries: string[] = [];
  private verboseEntries: string[] = [];

  debug(message: string): void {
    this.entries.push(message);
  }

  verbose(message: string): void {
    this.verboseEntries.push(message);
  }

  getEntries(): string[] {
    return [...this.entries];
  }

  getVerboseEntries(): string[] {
    return [...this.verboseEntries];
  }
}

const MAX_LOG_SIZE_BYTES = 500 * 1024; // 500 KB

export class FileLogger implements ILogger {
  private readonly resolvedPath: string;
  private readonly logLevel: LogLevel;

  constructor(filePath: string, maxSizeBytes?: number, logLevel: LogLevel = "info") {
    this.resolvedPath = filePath;
    this.logLevel = logLevel;
    this.rotateIfNeeded(maxSizeBytes ?? MAX_LOG_SIZE_BYTES);
    this.writeSessionHeader();
  }

  debug(message: string): void {
    this.writeLog(message);
  }

  verbose(message: string): void {
    if (this.logLevel !== "debug") {
      return;
    }
    this.writeLog(message);
  }

  private writeLog(message: string): void {
    const timestamp = new Date().toISOString();
    appendFileSync(this.resolvedPath, `[${timestamp}] ${message}\n`);
  }

  getFilePath(): string {
    return this.resolvedPath;
  }

  private rotateIfNeeded(maxSizeBytes: number): void {
    if (!existsSync(this.resolvedPath)) {
      return;
    }

    const stats = statSync(this.resolvedPath);
    if (stats.size < maxSizeBytes) {
      return;
    }

    const dir = path.dirname(this.resolvedPath);
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const rotatedName = `debug.${timestamp}.log`;
    const rotatedPath = path.join(dir, rotatedName);
    renameSync(this.resolvedPath, rotatedPath);
  }

  private writeSessionHeader(): void {
    const timestamp = new Date().toISOString();
    const separator = existsSync(this.resolvedPath) ? "\n" : "";
    appendFileSync(this.resolvedPath, `${separator}[${timestamp}] === Session started === log: ${this.resolvedPath}\n`);
  }
}
