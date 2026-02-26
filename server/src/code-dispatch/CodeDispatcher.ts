import * as path from "node:path";
import type { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { IClock } from "../substrate/abstractions/IClock";
import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import type { BackendType, CodeTask, CodeResult } from "./types";

/**
 * CodeDispatcher — loads coding context, routes tasks to a backend, gates with
 * an optional test command, and reverts changes if tests fail.
 */
export class CodeDispatcher {
  constructor(
    private readonly fs: IFileSystem,
    private readonly processRunner: IProcessRunner,
    private readonly substratePath: string,
    private readonly backends: Map<BackendType, ICodeBackend>,
    private readonly clock: IClock,
    private readonly defaultBackend: BackendType = "auto",
  ) {}

  async dispatch(task: CodeTask): Promise<CodeResult> {
    const startMs = this.clock.now().getTime();
    const cwd = task.cwd ?? process.cwd();

    // 1. Load CODING_CONTEXT.md (optional — proceed without it if absent)
    let codingContext = "";
    try {
      const contextPath = path.join(this.substratePath, "..", "CODING_CONTEXT.md");
      codingContext = await this.fs.readFile(contextPath);
    } catch {
      // CODING_CONTEXT.md is optional; continue without it
    }

    // 2. Read specified source files
    const fileContents = new Map<string, string>();
    for (const filePath of task.files) {
      try {
        fileContents.set(filePath, await this.fs.readFile(filePath));
      } catch {
        // Skip files that cannot be read
      }
    }

    // 3. Select backend
    const backendType = this.selectBackend(task);
    const backend = this.backends.get(backendType);
    if (!backend) {
      return {
        success: false,
        output: "",
        filesChanged: [],
        testsPassed: null,
        error: `Backend "${backendType}" is not registered`,
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    // Build backend-specific model override if provided
    const context: SubstrateSlice = { codingContext, fileContents, cwd };

    // 4. Invoke backend
    let backendResult;
    try {
      backendResult = await backend.invoke(task.spec, context);
    } catch (err) {
      return {
        success: false,
        output: "",
        filesChanged: [],
        testsPassed: null,
        error: err instanceof Error ? err.message : String(err),
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    if (!backendResult.success) {
      return {
        success: false,
        output: backendResult.output,
        filesChanged: [],
        testsPassed: null,
        error: `Backend exited with code ${backendResult.exitCode}`,
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    // 5. Get changed files via git diff
    const filesChanged = await this.getChangedFiles(cwd);

    // 6. Run tests if testCommand specified
    if (!task.testCommand) {
      return {
        success: true,
        output: backendResult.output,
        filesChanged,
        testsPassed: null,
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    const testsPassed = await this.runTests(task.testCommand, cwd);

    // 7. Revert changes if tests fail
    if (!testsPassed) {
      await this.revertChanges(cwd);
      return {
        success: false,
        output: backendResult.output,
        filesChanged,
        testsPassed: false,
        error: "Tests failed — changes reverted",
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    return {
      success: true,
      output: backendResult.output,
      filesChanged,
      testsPassed: true,
      backendUsed: backendType,
      durationMs: this.clock.now().getTime() - startMs,
    };
  }

  private selectBackend(task: CodeTask): BackendType {
    if (task.backend && task.backend !== "auto") return task.backend;

    // When a non-auto default is configured, use it directly
    if (this.defaultBackend !== "auto") {
      return this.defaultBackend;
    }

    // Heuristic — use usage data to tune thresholds over time:
    // Many files or no files listed → prefer copilot (agentic, discovers scope)
    // Single file listed           → prefer claude (fast, surgical)
    // No test command              → analysis task, prefer claude
    if (!task.testCommand) return "claude";
    if (task.files.length === 1) return "claude";
    return "copilot";
  }

  private async getChangedFiles(cwd: string): Promise<string[]> {
    try {
      const result = await this.processRunner.run("git", ["diff", "--name-only"], { cwd });
      if (result.exitCode !== 0) return [];
      return result.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async runTests(testCommand: string, cwd: string): Promise<boolean> {
    try {
      const [cmd, ...args] = testCommand.split(/\s+/);
      const result = await this.processRunner.run(cmd, args, { cwd });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async revertChanges(cwd: string): Promise<void> {
    try {
      await this.processRunner.run("git", ["checkout", "--", "."], { cwd });
    } catch { /* best-effort */ }
    try {
      await this.processRunner.run("git", ["clean", "-fd"], { cwd });
    } catch { /* best-effort */ }
  }
}
