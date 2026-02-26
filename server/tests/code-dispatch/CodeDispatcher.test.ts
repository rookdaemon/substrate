import { CodeDispatcher } from "../../src/code-dispatch/CodeDispatcher";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import type { ICodeBackend, SubstrateSlice, BackendResult } from "../../src/code-dispatch/ICodeBackend";
import type { BackendType, CodeTask } from "../../src/code-dispatch/types";

/** Controllable in-memory backend for testing CodeDispatcher */
class InMemoryCodeBackend implements ICodeBackend {
  readonly name: BackendType;
  private responses: BackendResult[] = [];
  readonly calls: Array<{ spec: string; context: SubstrateSlice }> = [];

  constructor(name: BackendType = "claude") {
    this.name = name;
  }

  enqueue(result: BackendResult): void {
    this.responses.push(result);
  }

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    this.calls.push({ spec, context });
    const response = this.responses.shift();
    if (!response) throw new Error("InMemoryCodeBackend: no responses enqueued");
    return response;
  }
}

const SUBSTRATE_PATH = "/substrate/substrate";
const CONTEXT_PATH = "/substrate/CODING_CONTEXT.md";
const CODING_CONTEXT = "# Coding Context\nFollow TypeScript conventions.";

function makeTask(overrides?: Partial<CodeTask>): CodeTask {
  return {
    spec: "Fix the off-by-one error",
    files: [],
    backend: "claude",
    ...overrides,
  };
}

function successBackendResult(output = "ok"): BackendResult {
  return { success: true, output, exitCode: 0, durationMs: 10 };
}

describe("CodeDispatcher", () => {
  let fs: InMemoryFileSystem;
  let processRunner: InMemoryProcessRunner;
  let clock: FixedClock;
  let claudeBackend: InMemoryCodeBackend;
  let copilotBackend: InMemoryCodeBackend;
  let dispatcher: CodeDispatcher;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    processRunner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    claudeBackend = new InMemoryCodeBackend("claude");
    copilotBackend = new InMemoryCodeBackend("copilot");
    const backends = new Map<BackendType, ICodeBackend>([
      ["claude", claudeBackend],
      ["copilot", copilotBackend],
    ]);
    dispatcher = new CodeDispatcher(fs, processRunner, SUBSTRATE_PATH, backends, clock);
  });

  describe("CODING_CONTEXT.md loading", () => {
    it("loads CODING_CONTEXT.md and passes it to the backend", async () => {
      await fs.writeFile(CONTEXT_PATH, CODING_CONTEXT);
      claudeBackend.enqueue(successBackendResult());
      // git diff --name-only
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

      await dispatcher.dispatch(makeTask());

      const ctx = claudeBackend.calls[0].context;
      expect(ctx.codingContext).toBe(CODING_CONTEXT);
    });

    it("proceeds without error when CODING_CONTEXT.md is absent", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask());
      expect(result.success).toBe(true);
      expect(claudeBackend.calls[0].context.codingContext).toBe("");
    });
  });

  describe("file loading", () => {
    it("reads listed source files and passes them in the context", async () => {
      await fs.writeFile("/src/foo.ts", "export const x = 1;");
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      await dispatcher.dispatch(makeTask({ files: ["/src/foo.ts"] }));

      const ctx = claudeBackend.calls[0].context;
      expect(ctx.fileContents.get("/src/foo.ts")).toBe("export const x = 1;");
    });

    it("skips files that do not exist", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask({ files: ["/nonexistent.ts"] }));
      expect(result.success).toBe(true);
      expect(claudeBackend.calls[0].context.fileContents.size).toBe(0);
    });
  });

  describe("backend selection", () => {
    it("uses 'claude' backend when backend='claude'", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask({ backend: "claude" }));
      expect(result.backendUsed).toBe("claude");
      expect(claudeBackend.calls).toHaveLength(1);
    });

    it("defaults to 'claude' backend when backend='auto'", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask({ backend: "auto" }));
      expect(result.backendUsed).toBe("claude");
    });

    it("defaults to 'claude' when no backend specified", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const task = makeTask();
      delete task.backend;
      const result = await dispatcher.dispatch(task);
      expect(result.backendUsed).toBe("claude");
    });

    it("auto with no testCommand routes to 'claude'", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(
        makeTask({ backend: "auto", testCommand: undefined, files: ["a.ts", "b.ts"] }),
      );
      expect(result.backendUsed).toBe("claude");
      expect(claudeBackend.calls).toHaveLength(1);
    });

    it("auto with single file + testCommand routes to 'claude'", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // test

      const result = await dispatcher.dispatch(
        makeTask({ backend: "auto", files: ["src/foo.ts"], testCommand: "npm test" }),
      );
      expect(result.backendUsed).toBe("claude");
      expect(claudeBackend.calls).toHaveLength(1);
    });

    it("auto with multiple files + testCommand routes to 'copilot'", async () => {
      copilotBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // test

      const result = await dispatcher.dispatch(
        makeTask({ backend: "auto", files: ["a.ts", "b.ts"], testCommand: "npm test" }),
      );
      expect(result.backendUsed).toBe("copilot");
      expect(copilotBackend.calls).toHaveLength(1);
    });

    it("auto with no files + testCommand routes to 'copilot' (agentic scope discovery)", async () => {
      copilotBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // test

      const result = await dispatcher.dispatch(
        makeTask({ backend: "auto", files: [], testCommand: "npm test" }),
      );
      expect(result.backendUsed).toBe("copilot");
      expect(copilotBackend.calls).toHaveLength(1);
    });

    it("returns error when backend is not registered", async () => {
      const backends = new Map<BackendType, ICodeBackend>(); // empty
      const emptyDispatcher = new CodeDispatcher(fs, processRunner, SUBSTRATE_PATH, backends, clock);

      const result = await emptyDispatcher.dispatch(makeTask({ backend: "claude" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('"claude" is not registered');
    });
  });

  describe("backend failure", () => {
    it("returns failure result when backend returns success=false", async () => {
      claudeBackend.enqueue({ success: false, output: "", exitCode: 1, durationMs: 5 });

      const result = await dispatcher.dispatch(makeTask());
      expect(result.success).toBe(false);
      expect(result.error).toContain("Backend exited with code 1");
    });

    it("returns failure result when backend throws", async () => {
      // No responses → InMemoryCodeBackend throws
      const result = await dispatcher.dispatch(makeTask());
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("git diff (filesChanged)", () => {
    it("parses changed files from git diff output", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "src/a.ts\nsrc/b.ts\n", stderr: "", exitCode: 0 });

      const result = await dispatcher.dispatch(makeTask());
      expect(result.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("returns empty array when git diff fails", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "not a git repo", exitCode: 128 });

      const result = await dispatcher.dispatch(makeTask());
      expect(result.filesChanged).toEqual([]);
    });
  });

  describe("test gating", () => {
    it("returns testsPassed=null when no testCommand is given", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask({ testCommand: undefined }));
      expect(result.testsPassed).toBeNull();
    });

    it("returns testsPassed=true when tests pass", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "a.ts", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "Tests passed", stderr: "", exitCode: 0 }); // npm test

      const result = await dispatcher.dispatch(makeTask({ testCommand: "npm test" }));
      expect(result.testsPassed).toBe(true);
      expect(result.success).toBe(true);
    });

    it("reverts changes and returns testsPassed=false when tests fail", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "a.ts", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "", stderr: "FAIL", exitCode: 1 });  // npm test fails
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 });       // git checkout -- .
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 });       // git clean -fd

      const result = await dispatcher.dispatch(makeTask({ testCommand: "npm test" }));
      expect(result.testsPassed).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toContain("reverted");

      // git checkout -- . was called
      const calls = processRunner.getCalls();
      const revertCall = calls.find(
        (c) => c.command === "git" && c.args[0] === "checkout"
      );
      expect(revertCall).toBeDefined();
      expect(revertCall!.args).toEqual(["checkout", "--", "."]);

      // git clean -fd was also called
      const cleanCall = calls.find(
        (c) => c.command === "git" && c.args[0] === "clean"
      );
      expect(cleanCall).toBeDefined();
      expect(cleanCall!.args).toEqual(["clean", "-fd"]);
    });

    it("passes cwd to test command", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // test

      await dispatcher.dispatch(makeTask({ testCommand: "npm test", cwd: "/my/project" }));

      const testCall = processRunner.getCalls().find((c) => c.command === "npm");
      expect(testCall?.options?.cwd).toBe("/my/project");
    });
  });

  describe("cwd", () => {
    it("passes task.cwd through to the backend context", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      await dispatcher.dispatch(makeTask({ cwd: "/repo" }));
      expect(claudeBackend.calls[0].context.cwd).toBe("/repo");
    });
  });

  describe("CodeResult fields", () => {
    it("reports durationMs using clock (FixedClock gives 0ms elapsed)", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask());
      // FixedClock always returns the same timestamp so elapsed = 0
      expect(result.durationMs).toBe(0);
    });

    it("includes backendUsed in result", async () => {
      claudeBackend.enqueue(successBackendResult());
      processRunner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // git diff

      const result = await dispatcher.dispatch(makeTask({ backend: "claude" }));
      expect(result.backendUsed).toBe("claude");
    });
  });
});
