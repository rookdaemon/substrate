import { SubstrateFileType, SubstrateFileLoadStrategy } from "../substrate/types";

export type CorrelationId = string;

export function generateCorrelationId(): CorrelationId {
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `drive-${Date.now()}-${random}`;
}

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
