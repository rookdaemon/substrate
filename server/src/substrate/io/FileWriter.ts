import { IFileSystem } from "../abstractions/IFileSystem";
import { ILogger } from "../../logging";
import { SubstrateConfig } from "../config";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS, WriteMode } from "../types";
import { validateSubstrateContent } from "../validation/validators";
import { validateHeartbeatContent } from "../../loop/HeartbeatParser";
import { scan } from "../validation/SecretDetector";
import { FileLock } from "./FileLock";
import { SubstrateFileReader } from "./FileReader";

export class SubstrateFileWriter {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly reader?: SubstrateFileReader,
    private readonly logger?: ILogger
  ) {}

  /**
   * Atomically write content to a file using a temp-file + rename pattern.
   * A caller-supplied validator runs on the content before the rename; on
   * failure the temp file is removed and the original is left untouched.
   */
  async atomicWrite(
    fileType: SubstrateFileType,
    content: string,
    validate: (content: string) => boolean
  ): Promise<void> {
    const spec = SUBSTRATE_FILE_SPECS[fileType];

    if (spec.writeMode === WriteMode.APPEND) {
      throw new Error(
        `Cannot use FileWriter for APPEND-mode file type: ${fileType}`
      );
    }

    const validation = validateSubstrateContent(content, fileType);
    if (!validation.valid) {
      throw new Error(
        `Validation failed for ${fileType}: ${validation.errors.join(", ")}`
      );
    }

    const contentToWrite = validation.redactedContent ?? content;
    if (validation.warnings.length > 0) {
      console.warn(`Substrate: redacted secrets on write to ${fileType}: ${validation.warnings.join("; ")}`);
    }

    const release = await this.lock.acquire(fileType);
    try {
      const filePath = this.config.getFilePath(fileType);
      const tempPath = `${filePath}.tmp`;

      await this.fs.writeFile(tempPath, contentToWrite);

      if (!validate(contentToWrite)) {
        await this.fs.unlink(tempPath).catch(() => undefined);
        throw new Error(
          `Atomic write validation failed for ${fileType} — merged result did not parse. Original preserved.`
        );
      }

      await this.fs.rename(tempPath, filePath);
      this.reader?.invalidate(filePath);
    } finally {
      release();
    }

    try {
      const matches = scan(content);
      if (matches.length > 0) {
        const types = [...new Set(matches.map(m => m.type))].join(", ");
        this.logger?.error(
          `[SECURITY] Secrets detected in write to ${fileType} — pattern types: ${types}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`FileWriter: secret scan failed for ${fileType}: ${msg}`);
    }
  }

  async write(fileType: SubstrateFileType, content: string): Promise<void> {
    const spec = SUBSTRATE_FILE_SPECS[fileType];

    if (spec.writeMode === WriteMode.APPEND) {
      throw new Error(
        `Cannot use FileWriter for APPEND-mode file type: ${fileType}`
      );
    }

    const validation = validateSubstrateContent(content, fileType);
    if (!validation.valid) {
      throw new Error(
        `Validation failed for ${fileType}: ${validation.errors.join(", ")}`
      );
    }

    if (fileType === SubstrateFileType.HEARTBEAT) {
      const hbValidation = validateHeartbeatContent(content);
      if (!hbValidation.valid) {
        throw new Error(hbValidation.errors.map((e) => e.message).join("\n\n"));
      }
    }

    // Redact secrets if detected, warn but don't block
    const contentToWrite = validation.redactedContent ?? content;
    if (validation.warnings.length > 0) {
      console.warn(`Substrate: redacted secrets on write to ${fileType}: ${validation.warnings.join("; ")}`);
    }

    const release = await this.lock.acquire(fileType);
    try {
      const filePath = this.config.getFilePath(fileType);
      await this.fs.writeFile(filePath, contentToWrite);
      this.reader?.invalidate(filePath);
    } finally {
      release();
    }

    // Post-write secret scan: alert at high severity if secrets were present in the written content.
    // This is intentionally post-write — the write may be needed for continuity and is not reverted;
    // logging is the enforcement mechanism (see issue R-S4 design approach).
    try {
      const matches = scan(content);
      if (matches.length > 0) {
        const types = [...new Set(matches.map(m => m.type))].join(", ");
        this.logger?.error(
          `[SECURITY] Secrets detected in write to ${fileType} — pattern types: ${types}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`FileWriter: secret scan failed for ${fileType}: ${msg}`);
    }
  }
}
