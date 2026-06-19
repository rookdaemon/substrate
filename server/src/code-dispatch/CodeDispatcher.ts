import * as path from "node:path";
import type { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { IClock } from "../substrate/abstractions/IClock";
import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import type { BackendType, CodeTask, CodeResult } from "./types";

export const DEFAULT_CODE_DISPATCH_GUARD_COMMAND = "npm test && npm run lint";

/**
 * CodeDispatcher — loads coding context, routes tasks to a backend, and gates
 * changed work with tests/lint. The default guard closes the self-modification
 * bypass where an agent could omit testCommand and still receive success after
 * changing source.
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
    const backendSelection = this.selectBackend(task);
    const backendType = backendSelection.backend;
    if (backendSelection.error) {
      return {
        success: false,
        output: "",
        filesChanged: [],
        testsPassed: null,
        error: backendSelection.error,
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

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

    const context: SubstrateSlice = { codingContext, fileContents, cwd };

    // 4. Invoke backend
    let backendResult;
    try {
      backendResult = await backend.invoke(task.spec, context, {
        model: task.model,
        effort: task.effort,
      });
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

    // 5. Get changed files via git status, including untracked files
    const filesChanged = await this.getChangedFiles(cwd);

    // 6. Run guard command when the backend changed files. If the caller did not
    // provide a command, use the full default test+lint guard.
    if (filesChanged.length === 0 && !task.testCommand) {
      return {
        success: true,
        output: backendResult.output,
        filesChanged,
        testsPassed: null,
        backendUsed: backendType,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }

    const guardCommand = task.testCommand ?? DEFAULT_CODE_DISPATCH_GUARD_COMMAND;
    const testsPassed = await this.runGuard(guardCommand, cwd);

    // 7. Do not auto-revert on guard failure. This dispatcher may run in a shared
    // or live checkout; destructive cleanup could erase unrelated user work.
    if (!testsPassed) {
      return {
        success: false,
        output: backendResult.output,
        filesChanged,
        testsPassed: false,
        error: "Guard command failed — changes preserved for review",
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

  private selectBackend(task: CodeTask): { backend: BackendType; error?: string } {
    if (task.backend && task.backend !== "auto") return { backend: task.backend };

    // A configured legacy shell default would make paid/opaque dispatch implicit
    // again. Keep those paths explicit per dispatch instead.
    if (this.defaultBackend !== "auto") {
      if (isLegacyCommercialShellBackend(this.defaultBackend)) {
        return {
          backend: this.defaultBackend,
          error:
            `Default code backend "${this.defaultBackend}" is a legacy commercial shell route. ` +
            `Set defaultCodeBackend to "pi", "codex", or "auto", or pass backend="${this.defaultBackend}" on an individual dispatch for an explicit one-off override.`,
        };
      }
      return { backend: this.defaultBackend };
    }

    // When the cognitive launcher is already portable (pi), route code dispatch
    // through the same portable shell rather than a separate commercial CLI.
    // This keeps the default execution surface consistent and reduces shell-
    // independence score blockers. Codex remains available as an explicit override.
    return { backend: "pi" };
  }

  private async getChangedFiles(cwd: string): Promise<string[]> {
    try {
      const result = await this.processRunner.run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd }
      );
      if (result.exitCode !== 0) return [];
      return result.stdout
        .split("\n")
        .map((line) => parseGitStatusPath(line))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async runGuard(testCommand: string, cwd: string): Promise<boolean> {
    try {
      const result = await this.processRunner.run("bash", ["-lc", testCommand], { cwd });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

}

function isLegacyCommercialShellBackend(backend: BackendType): boolean {
  return backend === "claude" || backend === "copilot" || backend === "gemini";
}

function parseGitStatusPath(line: string): string {
  if (!line.trim()) return "";
  if (line.length < 4 || line[2] !== " ") {
    return line.trim();
  }
  const pathPart = line.slice(3).trim();
  const renameArrow = " -> ";
  if (pathPart.includes(renameArrow)) {
    return pathPart.slice(pathPart.lastIndexOf(renameArrow) + renameArrow.length).trim();
  }
  return pathPart;
}
