import {
  SubstrateFileType,
  WriteMode,
  SUBSTRATE_FILE_SPECS,
} from "../../src/substrate/types";

describe("SubstrateFileType", () => {
  it("defines all file types", () => {
    const types = Object.values(SubstrateFileType);
    expect(types.length).toBeGreaterThanOrEqual(12);
  });

  it("includes expected types", () => {
    expect(SubstrateFileType.PLAN).toBeDefined();
    expect(SubstrateFileType.MEMORY).toBeDefined();
    expect(SubstrateFileType.HABITS).toBeDefined();
    expect(SubstrateFileType.SKILLS).toBeDefined();
    expect(SubstrateFileType.VALUES).toBeDefined();
    expect(SubstrateFileType.ID).toBeDefined();
    expect(SubstrateFileType.SECURITY).toBeDefined();
    expect(SubstrateFileType.CHARTER).toBeDefined();
    expect(SubstrateFileType.SUPEREGO).toBeDefined();
    expect(SubstrateFileType.CLAUDE).toBeDefined();
    expect(SubstrateFileType.PROGRESS).toBeDefined();
    expect(SubstrateFileType.CONVERSATION).toBeDefined();
  });
});

describe("SUBSTRATE_FILE_SPECS", () => {
  it("has a spec for every SubstrateFileType", () => {
    for (const type of Object.values(SubstrateFileType)) {
      expect(SUBSTRATE_FILE_SPECS[type]).toBeDefined();
      expect(SUBSTRATE_FILE_SPECS[type].fileName).toBeTruthy();
      expect(SUBSTRATE_FILE_SPECS[type].writeMode).toBeDefined();
      expect(typeof SUBSTRATE_FILE_SPECS[type].required).toBe("boolean");
    }
  });

  it("uses APPEND mode for PROGRESS and CONVERSATION", () => {
    expect(SUBSTRATE_FILE_SPECS[SubstrateFileType.PROGRESS].writeMode).toBe(
      WriteMode.APPEND
    );
    expect(
      SUBSTRATE_FILE_SPECS[SubstrateFileType.CONVERSATION].writeMode
    ).toBe(WriteMode.APPEND);
  });

  it("uses OVERWRITE mode for all other types", () => {
    const overwriteTypes = Object.values(SubstrateFileType).filter(
      (t) => t !== SubstrateFileType.PROGRESS && t !== SubstrateFileType.CONVERSATION
    );
    for (const type of overwriteTypes) {
      expect(SUBSTRATE_FILE_SPECS[type].writeMode).toBe(WriteMode.OVERWRITE);
    }
  });

  it("marks core files as required and optional files as not required", () => {
    const optionalTypes = [SubstrateFileType.PEERS, SubstrateFileType.AGORA_INBOX];
    for (const type of Object.values(SubstrateFileType)) {
      if (optionalTypes.includes(type)) {
        expect(SUBSTRATE_FILE_SPECS[type].required).toBe(false);
      } else {
        expect(SUBSTRATE_FILE_SPECS[type].required).toBe(true);
      }
    }
  });
});
