import {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "./ISessionLauncher";

export interface RecordedLaunch {
  request: ClaudeSessionRequest;
  options?: LaunchOptions;
}

export class InMemorySessionLauncher implements ISessionLauncher {
  private responses: ClaudeSessionResult[] = [];
  private launches: RecordedLaunch[] = [];

  enqueueSuccess(rawOutput: string): void {
    this.responses.push({
      rawOutput,
      exitCode: 0,
      durationMs: 0,
      success: true,
    });
  }

  enqueueFailure(error: string): void {
    this.responses.push({
      rawOutput: "",
      exitCode: 1,
      durationMs: 0,
      success: false,
      error,
    });
  }

  enqueue(result: ClaudeSessionResult): void {
    this.responses.push(result);
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult> {
    this.launches.push({ request, options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No more canned responses in InMemorySessionLauncher");
    }
    return response;
  }

  getLaunches(): RecordedLaunch[] {
    return [...this.launches];
  }

  reset(): void {
    this.responses = [];
    this.launches = [];
  }
}
