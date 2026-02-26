import type { BackendType } from "./types";

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

export interface ICodeBackend {
  readonly name: BackendType;
  invoke(spec: string, context: SubstrateSlice): Promise<BackendResult>;
}
