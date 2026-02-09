import {
  ROLE_PERMISSIONS,
  PermissionChecker,
} from "../../src/agents/permissions";
import {
  AgentRole,
  FileAccessLevel,
} from "../../src/agents/types";
import { SubstrateFileType } from "../../src/substrate/types";

describe("ROLE_PERMISSIONS", () => {
  it("defines permissions for all 4 roles", () => {
    expect(ROLE_PERMISSIONS[AgentRole.EGO]).toBeDefined();
    expect(ROLE_PERMISSIONS[AgentRole.SUBCONSCIOUS]).toBeDefined();
    expect(ROLE_PERMISSIONS[AgentRole.SUPEREGO]).toBeDefined();
    expect(ROLE_PERMISSIONS[AgentRole.ID]).toBeDefined();
  });

  it("gives Ego read access to most files", () => {
    const egoPerms = ROLE_PERMISSIONS[AgentRole.EGO];
    const readFiles = egoPerms
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .map((p) => p.fileType);
    expect(readFiles).toContain(SubstrateFileType.PLAN);
    expect(readFiles).toContain(SubstrateFileType.MEMORY);
    expect(readFiles).toContain(SubstrateFileType.VALUES);
    expect(readFiles).toContain(SubstrateFileType.ID);
    expect(readFiles).toContain(SubstrateFileType.SKILLS);
    expect(readFiles).toContain(SubstrateFileType.HABITS);
    expect(readFiles).toContain(SubstrateFileType.CHARTER);
    expect(readFiles).toContain(SubstrateFileType.PROGRESS);
    expect(readFiles).toContain(SubstrateFileType.CONVERSATION);
  });

  it("gives Ego write access to PLAN", () => {
    const egoPerms = ROLE_PERMISSIONS[AgentRole.EGO];
    const writeFiles = egoPerms
      .filter((p) => p.accessLevel === FileAccessLevel.WRITE)
      .map((p) => p.fileType);
    expect(writeFiles).toContain(SubstrateFileType.PLAN);
  });

  it("gives Ego append access to CONVERSATION", () => {
    const egoPerms = ROLE_PERMISSIONS[AgentRole.EGO];
    const appendFiles = egoPerms
      .filter((p) => p.accessLevel === FileAccessLevel.APPEND)
      .map((p) => p.fileType);
    expect(appendFiles).toContain(SubstrateFileType.CONVERSATION);
  });

  it("gives Subconscious write access to PLAN and SKILLS", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.SUBCONSCIOUS];
    const writeFiles = perms
      .filter((p) => p.accessLevel === FileAccessLevel.WRITE)
      .map((p) => p.fileType);
    expect(writeFiles).toContain(SubstrateFileType.PLAN);
    expect(writeFiles).toContain(SubstrateFileType.SKILLS);
  });

  it("gives Subconscious append access to PROGRESS and CONVERSATION", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.SUBCONSCIOUS];
    const appendFiles = perms
      .filter((p) => p.accessLevel === FileAccessLevel.APPEND)
      .map((p) => p.fileType);
    expect(appendFiles).toContain(SubstrateFileType.PROGRESS);
    expect(appendFiles).toContain(SubstrateFileType.CONVERSATION);
  });

  it("gives Superego read access to ALL files", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.SUPEREGO];
    const readFiles = perms
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .map((p) => p.fileType);
    for (const ft of Object.values(SubstrateFileType)) {
      expect(readFiles).toContain(ft);
    }
  });

  it("gives Superego append access to PROGRESS only", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.SUPEREGO];
    const appendFiles = perms
      .filter((p) => p.accessLevel === FileAccessLevel.APPEND)
      .map((p) => p.fileType);
    expect(appendFiles).toEqual([SubstrateFileType.PROGRESS]);
  });

  it("gives Superego no write access", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.SUPEREGO];
    const writeFiles = perms.filter(
      (p) => p.accessLevel === FileAccessLevel.WRITE
    );
    expect(writeFiles).toHaveLength(0);
  });

  it("gives Id read access to ID, VALUES, PLAN, PROGRESS, SKILLS only", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.ID];
    const readFiles = perms
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .map((p) => p.fileType);
    expect(readFiles).toContain(SubstrateFileType.ID);
    expect(readFiles).toContain(SubstrateFileType.VALUES);
    expect(readFiles).toContain(SubstrateFileType.PLAN);
    expect(readFiles).toContain(SubstrateFileType.PROGRESS);
    expect(readFiles).toContain(SubstrateFileType.SKILLS);
    expect(readFiles).toHaveLength(5);
  });

  it("gives Id no write or append access", () => {
    const perms = ROLE_PERMISSIONS[AgentRole.ID];
    const writePerms = perms.filter(
      (p) =>
        p.accessLevel === FileAccessLevel.WRITE ||
        p.accessLevel === FileAccessLevel.APPEND
    );
    expect(writePerms).toHaveLength(0);
  });
});

describe("PermissionChecker", () => {
  let checker: PermissionChecker;

  beforeEach(() => {
    checker = new PermissionChecker();
  });

  describe("canRead", () => {
    it("returns true when role has READ permission", () => {
      expect(checker.canRead(AgentRole.EGO, SubstrateFileType.PLAN)).toBe(true);
    });

    it("returns false when role lacks READ permission", () => {
      expect(checker.canRead(AgentRole.ID, SubstrateFileType.MEMORY)).toBe(false);
    });

    it("Superego can read any file", () => {
      for (const ft of Object.values(SubstrateFileType)) {
        expect(checker.canRead(AgentRole.SUPEREGO, ft)).toBe(true);
      }
    });
  });

  describe("canWrite", () => {
    it("returns true when role has WRITE permission", () => {
      expect(checker.canWrite(AgentRole.EGO, SubstrateFileType.PLAN)).toBe(true);
    });

    it("returns false when role lacks WRITE permission", () => {
      expect(checker.canWrite(AgentRole.SUPEREGO, SubstrateFileType.PLAN)).toBe(false);
    });

    it("Subconscious can write PLAN and SKILLS", () => {
      expect(checker.canWrite(AgentRole.SUBCONSCIOUS, SubstrateFileType.PLAN)).toBe(true);
      expect(checker.canWrite(AgentRole.SUBCONSCIOUS, SubstrateFileType.SKILLS)).toBe(true);
    });

    it("Id cannot write anything", () => {
      for (const ft of Object.values(SubstrateFileType)) {
        expect(checker.canWrite(AgentRole.ID, ft)).toBe(false);
      }
    });
  });

  describe("canAppend", () => {
    it("returns true when role has APPEND permission", () => {
      expect(checker.canAppend(AgentRole.EGO, SubstrateFileType.CONVERSATION)).toBe(true);
    });

    it("returns false when role lacks APPEND permission", () => {
      expect(checker.canAppend(AgentRole.EGO, SubstrateFileType.PROGRESS)).toBe(false);
    });

    it("Superego can append to PROGRESS", () => {
      expect(checker.canAppend(AgentRole.SUPEREGO, SubstrateFileType.PROGRESS)).toBe(true);
    });

    it("Subconscious can append to PROGRESS", () => {
      expect(checker.canAppend(AgentRole.SUBCONSCIOUS, SubstrateFileType.PROGRESS)).toBe(true);
    });
  });

  describe("assertCanRead", () => {
    it("does not throw when permitted", () => {
      expect(() => checker.assertCanRead(AgentRole.EGO, SubstrateFileType.PLAN)).not.toThrow();
    });

    it("throws when not permitted", () => {
      expect(() => checker.assertCanRead(AgentRole.ID, SubstrateFileType.MEMORY)).toThrow(
        "ID does not have READ access to MEMORY"
      );
    });
  });

  describe("assertCanWrite", () => {
    it("does not throw when permitted", () => {
      expect(() => checker.assertCanWrite(AgentRole.EGO, SubstrateFileType.PLAN)).not.toThrow();
    });

    it("throws when not permitted", () => {
      expect(() => checker.assertCanWrite(AgentRole.SUPEREGO, SubstrateFileType.PLAN)).toThrow(
        "SUPEREGO does not have WRITE access to PLAN"
      );
    });
  });

  describe("assertCanAppend", () => {
    it("does not throw when permitted", () => {
      expect(() =>
        checker.assertCanAppend(AgentRole.EGO, SubstrateFileType.CONVERSATION)
      ).not.toThrow();
    });

    it("throws when not permitted", () => {
      expect(() =>
        checker.assertCanAppend(AgentRole.ID, SubstrateFileType.PROGRESS)
      ).toThrow("ID does not have APPEND access to PROGRESS");
    });
  });

  describe("getReadableFiles", () => {
    it("returns all files a role can read", () => {
      const readable = checker.getReadableFiles(AgentRole.ID);
      expect(readable).toHaveLength(5);
      expect(readable).toContain(SubstrateFileType.ID);
      expect(readable).toContain(SubstrateFileType.VALUES);
      expect(readable).toContain(SubstrateFileType.PLAN);
      expect(readable).toContain(SubstrateFileType.PROGRESS);
      expect(readable).toContain(SubstrateFileType.SKILLS);
    });

    it("returns all 12 files for Superego", () => {
      const readable = checker.getReadableFiles(AgentRole.SUPEREGO);
      expect(readable).toHaveLength(12);
    });
  });
});
