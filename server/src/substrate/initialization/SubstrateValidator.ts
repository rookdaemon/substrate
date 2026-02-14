import { IFileSystem } from "../abstractions/IFileSystem";
import { SubstrateConfig } from "../config";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS } from "../types";
import { validateSubstrateContent } from "../validation/validators";

export interface InvalidFileEntry {
  fileType: SubstrateFileType;
  errors: string[];
}

export interface SubstrateValidationResult {
  valid: boolean;
  missingFiles: SubstrateFileType[];
  invalidFiles: InvalidFileEntry[];
}

export class SubstrateValidator {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig
  ) {}

  async validate(): Promise<SubstrateValidationResult> {
    const missingFiles: SubstrateFileType[] = [];
    const invalidFiles: InvalidFileEntry[] = [];

    for (const fileType of Object.values(SubstrateFileType)) {
      const filePath = this.config.getFilePath(fileType);

      if (!(await this.fs.exists(filePath))) {
        // Only report required files as missing
        if (SUBSTRATE_FILE_SPECS[fileType].required) {
          missingFiles.push(fileType);
        }
        continue;
      }

      const content = await this.fs.readFile(filePath);
      const result = validateSubstrateContent(content, fileType);
      if (!result.valid) {
        invalidFiles.push({ fileType, errors: result.errors });
      }
    }

    return {
      valid: missingFiles.length === 0 && invalidFiles.length === 0,
      missingFiles,
      invalidFiles,
    };
  }
}
