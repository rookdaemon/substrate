export type BackendType = "copilot" | "claude" | "gemini" | "auto";

export interface CodeTask {
  spec: string;
  backend?: BackendType;
  files: string[];
  testCommand?: string;
  model?: string;
  cwd?: string;
}

export interface CodeResult {
  success: boolean;
  output: string;
  filesChanged: string[];
  testsPassed: boolean | null;
  error?: string;
  backendUsed: BackendType;
  durationMs: number;
}
