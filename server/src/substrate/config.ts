import * as path from "node:path";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS } from "./types";

export class SubstrateConfig {
  readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  getFilePath(fileType: SubstrateFileType): string {
    const spec = SUBSTRATE_FILE_SPECS[fileType];
    return this.joinInsideBase(spec.fileName);
  }

  getBackupDir(): string {
    return this.joinInsideBase("backups");
  }

  private joinInsideBase(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Substrate path must be relative: ${relativePath}`);
    }

    const resolved = path.resolve(this.basePath, relativePath);
    const rel = path.relative(this.basePath, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Substrate path escapes base directory: ${relativePath}`);
    }

    return resolved;
  }
}
