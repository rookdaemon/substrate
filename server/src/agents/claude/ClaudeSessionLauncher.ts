import { IClock } from "../../substrate/abstractions/IClock";
import { ILogger } from "../../logging";
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

const noopLogger: ILogger = { debug() {} };

export class ClaudeSessionLauncher {
  private readonly model: string;
  private readonly logger: ILogger;

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    model?: string,
    logger?: ILogger
  ) {
    this.model = model ?? "sonnet";
    this.logger = logger ?? noopLogger;
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
        this.logger.debug(`launch: retrying in ${retryDelayMs}ms`);
        await this.delay(retryDelayMs);
      }

      const startTime = this.clock.now();

      const parser = new StreamJsonParser((entry) => {
        this.logger.debug(`  [${entry.type}] ${entry.content}`);
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

      this.logger.debug(`launch: attempt ${attempt + 1}/${maxRetries} cwd=${options?.cwd ?? "(inherit)"}`);
      this.logger.debug(`  $ claude ${args.map((a) => a.includes(" ") || a.includes("\n") ? JSON.stringify(a) : a).join(" ")}`);

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

      this.logger.debug(`launch: done — exitCode=${lastResult.exitCode} success=${lastResult.success} duration=${durationMs}ms output="${lastResult.rawOutput}"`);

      if (lastResult.error) {
        this.logger.debug(`launch: error — ${lastResult.error}`);
      }

      if (lastResult.success) return lastResult;
    }

    return lastResult!;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
