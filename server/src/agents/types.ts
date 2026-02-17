import { SubstrateFileType, SubstrateFileLoadStrategy } from "../substrate/types";

export enum AgentRole {
  EGO = "EGO",
  SUBCONSCIOUS = "SUBCONSCIOUS",
  SUPEREGO = "SUPEREGO",
  ID = "ID",
}

export enum FileAccessLevel {
  READ = "READ",
  WRITE = "WRITE",
  APPEND = "APPEND",
}

export interface FilePermission {
  fileType: SubstrateFileType;
  accessLevel: FileAccessLevel;
  loadStrategy?: SubstrateFileLoadStrategy;
}

export interface AgentAction {
  type: string;
  role: AgentRole;
}

export interface FileWriteAction extends AgentAction {
  type: "file_write";
  fileType: SubstrateFileType;
  content: string;
}

export interface FileAppendAction extends AgentAction {
  type: "file_append";
  fileType: SubstrateFileType;
  entry: string;
}

export interface TaskDispatch extends AgentAction {
  type: "task_dispatch";
  targetRole: AgentRole;
  taskId: string;
  description: string;
}
