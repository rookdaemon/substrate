import { IClock } from "../../substrate/abstractions/IClock";
import { IProcessRunner } from "./IProcessRunner";
import { StreamJsonParser, ProcessLogEntry } from "./StreamJsonParser";

export interface ClaudeSessionRequest {
  systemPrompt: string;
  message: string;
}

export interface ClaudeSessionResult {
  rawOutput: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface LaunchOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  onLogEntry?: (entry: ProcessLogEntry) => void;
  cwd?: string;
}

export class ClaudeSessionLauncher {
  private readonly model: string;

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    model?: string
  ) {
    this.model = model ?? "sonnet";
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult> {
    const maxRetries = options?.maxRetries ?? 1;
    const retryDelayMs = options?.retryDelayMs ?? 1000;

    let lastResult: ClaudeSessionResult | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0 && retryDelayMs > 0) {
        await this.delay(retryDelayMs);
      }

      const startTime = this.clock.now();

      const parser = new StreamJsonParser((entry) => {
        options?.onLogEntry?.(entry);
      });

      const args = [
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        this.model,
        "--output-format",
        "stream-json",
        "--system-prompt",
        request.systemPrompt,
        request.message,
      ];

      const processResult = await this.processRunner.run("claude", args, {
        onStdout: (chunk) => parser.push(chunk),
        cwd: options?.cwd,
      });

      parser.flush();

      const endTime = this.clock.now();
      const durationMs = endTime.getTime() - startTime.getTime();

      lastResult = {
        rawOutput: parser.getTextContent(),
        exitCode: processResult.exitCode,
        durationMs,
        success: processResult.exitCode === 0,
        error:
          processResult.exitCode !== 0
            ? processResult.stderr
            : undefined,
      };

      if (lastResult.success) return lastResult;
    }

    return lastResult!;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
