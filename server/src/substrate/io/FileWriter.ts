import { IFileSystem } from "../abstractions/IFileSystem";
import { SubstrateConfig } from "../config";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS, WriteMode } from "../types";
import { validateSubstrateContent } from "../validation/validators";
import { FileLock } from "./FileLock";
import { SubstrateFileReader } from "./FileReader";

export class SubstrateFileWriter {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly reader?: SubstrateFileReader
  ) {}

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
  }
}
