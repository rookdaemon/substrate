import { IFileSystem } from "../abstractions/IFileSystem";
import { IClock } from "../abstractions/IClock";
import { SubstrateConfig } from "../config";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS, WriteMode } from "../types";
import { detectSecrets, formatSecretErrors, redactSecrets } from "../validation/SecretDetector";
import { FileLock } from "./FileLock";
import { SubstrateFileReader } from "./FileReader";

export class AppendOnlyWriter {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly clock: IClock,
    private readonly reader?: SubstrateFileReader
  ) {}

  async append(fileType: SubstrateFileType, entry: string): Promise<void> {
    const spec = SUBSTRATE_FILE_SPECS[fileType];

    if (spec.writeMode !== WriteMode.APPEND) {
      throw new Error(
        `Cannot use AppendOnlyWriter for OVERWRITE-mode file type: ${fileType}`
      );
    }

    // Secret detection: redact and warn, don't block
    const secretResult = detectSecrets(entry);
    if (secretResult.hasSecrets) {
      const warnings = formatSecretErrors(secretResult);
      console.warn(`Substrate: redacted secrets on append to ${fileType}: ${warnings.join("; ")}`);
      entry = redactSecrets(entry, secretResult);
    }

    const release = await this.lock.acquire(fileType);
    try {
      const filePath = this.config.getFilePath(fileType);
      const timestamp = this.clock.now().toISOString();
      const formatted = `[${timestamp}] ${entry}\n`;
      await this.fs.appendFile(filePath, formatted);
      this.reader?.invalidate(filePath);
    } finally {
      release();
    }
  }
}
