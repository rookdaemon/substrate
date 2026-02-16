import { SubstrateFileType } from "../substrate/types";
import { AgentRole, FileAccessLevel, FilePermission } from "./types";

function read(fileType: SubstrateFileType): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.READ };
}

function write(fileType: SubstrateFileType): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.WRITE };
}

function append(fileType: SubstrateFileType): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.APPEND };
}

export const ROLE_PERMISSIONS: Record<AgentRole, FilePermission[]> = {
  [AgentRole.EGO]: [
    read(SubstrateFileType.PLAN),
    read(SubstrateFileType.MEMORY),
    read(SubstrateFileType.HABITS),
    read(SubstrateFileType.SKILLS),
    read(SubstrateFileType.VALUES),
    read(SubstrateFileType.ID),
    read(SubstrateFileType.CHARTER),
    read(SubstrateFileType.PROGRESS),
    read(SubstrateFileType.CONVERSATION),
    read(SubstrateFileType.PEERS),
    read(SubstrateFileType.AGORA_INBOX),
    write(SubstrateFileType.PLAN),
    append(SubstrateFileType.CONVERSATION),
  ],

  [AgentRole.SUBCONSCIOUS]: [
    read(SubstrateFileType.PLAN),
    read(SubstrateFileType.MEMORY),
    read(SubstrateFileType.HABITS),
    read(SubstrateFileType.SKILLS),
    read(SubstrateFileType.VALUES),
    read(SubstrateFileType.PROGRESS),
    read(SubstrateFileType.PEERS),
    read(SubstrateFileType.AGORA_INBOX),
    write(SubstrateFileType.PLAN),
    write(SubstrateFileType.SKILLS),
    write(SubstrateFileType.MEMORY),
    write(SubstrateFileType.PEERS),
    write(SubstrateFileType.AGORA_INBOX),
    append(SubstrateFileType.PROGRESS),
    append(SubstrateFileType.CONVERSATION),
  ],

  [AgentRole.SUPEREGO]: [
    ...Object.values(SubstrateFileType).map(read),
    append(SubstrateFileType.PROGRESS),
    append(SubstrateFileType.ESCALATE_TO_STEFAN),
  ],

  [AgentRole.ID]: [
    read(SubstrateFileType.ID),
    read(SubstrateFileType.VALUES),
    read(SubstrateFileType.PLAN),
    read(SubstrateFileType.PROGRESS),
    read(SubstrateFileType.SKILLS),
    read(SubstrateFileType.MEMORY),
  ],
};

export class PermissionChecker {
  canRead(role: AgentRole, fileType: SubstrateFileType): boolean {
    return this.hasPermission(role, fileType, FileAccessLevel.READ);
  }

  canWrite(role: AgentRole, fileType: SubstrateFileType): boolean {
    return this.hasPermission(role, fileType, FileAccessLevel.WRITE);
  }

  canAppend(role: AgentRole, fileType: SubstrateFileType): boolean {
    return this.hasPermission(role, fileType, FileAccessLevel.APPEND);
  }

  assertCanRead(role: AgentRole, fileType: SubstrateFileType): void {
    if (!this.canRead(role, fileType)) {
      throw new Error(`${role} does not have READ access to ${fileType}`);
    }
  }

  assertCanWrite(role: AgentRole, fileType: SubstrateFileType): void {
    if (!this.canWrite(role, fileType)) {
      throw new Error(`${role} does not have WRITE access to ${fileType}`);
    }
  }

  assertCanAppend(role: AgentRole, fileType: SubstrateFileType): void {
    if (!this.canAppend(role, fileType)) {
      throw new Error(`${role} does not have APPEND access to ${fileType}`);
    }
  }

  getReadableFiles(role: AgentRole): SubstrateFileType[] {
    return ROLE_PERMISSIONS[role]
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .map((p) => p.fileType);
  }

  private hasPermission(
    role: AgentRole,
    fileType: SubstrateFileType,
    accessLevel: FileAccessLevel
  ): boolean {
    return ROLE_PERMISSIONS[role].some(
      (p) => p.fileType === fileType && p.accessLevel === accessLevel
    );
  }
}
