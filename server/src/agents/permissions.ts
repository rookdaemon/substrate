import { SubstrateFileType, SubstrateFileLoadStrategy } from "../substrate/types";
import { AgentRole, FileAccessLevel, FilePermission } from "./types";

function read(fileType: SubstrateFileType, loadStrategy?: SubstrateFileLoadStrategy): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.READ, loadStrategy };
}

function write(fileType: SubstrateFileType): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.WRITE };
}

function append(fileType: SubstrateFileType): FilePermission {
  return { fileType, accessLevel: FileAccessLevel.APPEND };
}

export const ROLE_PERMISSIONS: Record<AgentRole, FilePermission[]> = {
  [AgentRole.EGO]: [
    read(SubstrateFileType.PLAN, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.MEMORY, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.HABITS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.SKILLS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.VALUES, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.ID, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.CHARTER, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.PROGRESS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.CONVERSATION, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.PEERS, SubstrateFileLoadStrategy.LAZY),
    write(SubstrateFileType.PLAN),
    append(SubstrateFileType.CONVERSATION),
  ],

  [AgentRole.SUBCONSCIOUS]: [
    read(SubstrateFileType.PLAN, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.MEMORY, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.HABITS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.SKILLS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.VALUES, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.PROGRESS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.PEERS, SubstrateFileLoadStrategy.LAZY),
    write(SubstrateFileType.PLAN),
    write(SubstrateFileType.SKILLS),
    write(SubstrateFileType.MEMORY),
    write(SubstrateFileType.PEERS),
    append(SubstrateFileType.PROGRESS),
    append(SubstrateFileType.CONVERSATION),
  ],

  [AgentRole.SUPEREGO]: [
    // Superego needs full context for auditing - all files EAGER
    ...Object.values(SubstrateFileType).map((ft) => read(ft, SubstrateFileLoadStrategy.EAGER)),
    write(SubstrateFileType.HABITS),
    write(SubstrateFileType.SECURITY),
    append(SubstrateFileType.PROGRESS),
    append(SubstrateFileType.ESCALATE_TO_STEFAN),
  ],

  [AgentRole.ID]: [
    read(SubstrateFileType.ID, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.VALUES, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.PLAN, SubstrateFileLoadStrategy.EAGER),
    read(SubstrateFileType.PROGRESS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.SKILLS, SubstrateFileLoadStrategy.LAZY),
    read(SubstrateFileType.MEMORY, SubstrateFileLoadStrategy.LAZY),
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

  getEagerFiles(role: AgentRole): SubstrateFileType[] {
    return ROLE_PERMISSIONS[role]
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .filter((p) => p.loadStrategy === SubstrateFileLoadStrategy.EAGER)
      .map((p) => p.fileType);
  }

  getLazyFiles(role: AgentRole): SubstrateFileType[] {
    return ROLE_PERMISSIONS[role]
      .filter((p) => p.accessLevel === FileAccessLevel.READ)
      .filter((p) => p.loadStrategy === SubstrateFileLoadStrategy.LAZY)
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
