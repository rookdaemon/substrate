import type { BackendType } from "./types";
import type { ReasoningEffort } from "../agents/reasoningEffort";

export interface SubstrateSlice {
  codingContext: string;
  fileContents: Map<string, string>;
  cwd: string;
}

export interface BackendResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface CodeBackendOptions {
  model?: string;
  effort?: ReasoningEffort;
}

export interface ICodeBackend {
  readonly name: BackendType;
  invoke(spec: string, context: SubstrateSlice, options?: CodeBackendOptions): Promise<BackendResult>;
}
