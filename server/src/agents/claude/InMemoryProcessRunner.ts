import {
  IProcessRunner,
  ProcessResult,
  ProcessRunOptions,
} from "./IProcessRunner";

export interface RecordedCall {
  command: string;
  args: string[];
  options?: ProcessRunOptions;
}

export class InMemoryProcessRunner implements IProcessRunner {
  private responses: ProcessResult[] = [];
  private calls: RecordedCall[] = [];

  enqueue(response: ProcessResult): void {
    this.responses.push(response);
  }

  async run(
    command: string,
    args: string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No more canned responses in InMemoryProcessRunner");
    }
    if (options?.onStdout && response.stdout) {
      options.onStdout(response.stdout);
    }
    return response;
  }

  getCalls(): RecordedCall[] {
    return [...this.calls];
  }

  reset(): void {
    this.responses = [];
    this.calls = [];
  }
}
