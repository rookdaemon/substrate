import { IProcessRunner, ProcessResult, ProcessOptions } from "./IProcessRunner";

interface ProcessCall {
  command: string;
  args: string[];
  options?: ProcessOptions;
}

/**
 * In-memory implementation of IProcessRunner for testing
 */
export class InMemoryProcessRunner implements IProcessRunner {
  private calls: ProcessCall[] = [];
  private responses: Map<string, ProcessResult> = new Map();

  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });

    // Check for mocked response
    const response = this.responses.get(command);
    if (response) {
      return response;
    }

    // Default successful response
    return {
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  }

  /**
   * Mock a response for a specific command
   */
  mockResponse(command: string, result: ProcessResult): void {
    this.responses.set(command, result);
  }

  /**
   * Get all process calls made
   */
  getCalls(): ProcessCall[] {
    return [...this.calls];
  }

  /**
   * Clear all calls and responses
   */
  clear(): void {
    this.calls = [];
    this.responses.clear();
  }
}
