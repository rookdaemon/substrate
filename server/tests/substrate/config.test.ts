import { SubstrateConfig } from "../../src/substrate/config";
import { SUBSTRATE_FILE_SPECS, SubstrateFileType } from "../../src/substrate/types";

describe("SubstrateConfig", () => {
  const config = new SubstrateConfig("/home/agent/substrate");

  it("resolves file path for a given file type", () => {
    expect(config.getFilePath(SubstrateFileType.PLAN)).toBe(
      "/home/agent/substrate/PLAN.md"
    );
  });

  it("resolves file path for CONVERSATION", () => {
    expect(config.getFilePath(SubstrateFileType.CONVERSATION)).toBe(
      "/home/agent/substrate/CONVERSATION.md"
    );
  });

  it("returns backup directory path", () => {
    expect(config.getBackupDir()).toBe("/home/agent/substrate/backups");
  });

  it("exposes the base path", () => {
    expect(config.basePath).toBe("/home/agent/substrate");
  });

  it("normalizes trailing slashes without changing target paths", () => {
    const trailing = new SubstrateConfig("/home/agent/substrate/");

    expect(trailing.getFilePath(SubstrateFileType.PLAN)).toBe(
      "/home/agent/substrate/PLAN.md"
    );
    expect(trailing.getBackupDir()).toBe("/home/agent/substrate/backups");
  });

  it("rejects file specs that would escape the substrate base", () => {
    const originalFileName = SUBSTRATE_FILE_SPECS[SubstrateFileType.PLAN].fileName;
    SUBSTRATE_FILE_SPECS[SubstrateFileType.PLAN].fileName = "../PLAN.md";

    try {
      expect(() => config.getFilePath(SubstrateFileType.PLAN)).toThrow(
        /escapes base directory/
      );
    } finally {
      SUBSTRATE_FILE_SPECS[SubstrateFileType.PLAN].fileName = originalFileName;
    }
  });
});
