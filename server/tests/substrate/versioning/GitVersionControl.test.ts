import { GitVersionControl } from "../../../src/substrate/versioning/GitVersionControl";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../../../src/substrate/abstractions/InMemoryProcessRunner";
import { InMemoryLogger } from "../../../src/logging";

describe("GitVersionControl", () => {
  let fs: InMemoryFileSystem;
  let processRunner: InMemoryProcessRunner;
  let logger: InMemoryLogger;
  let git: GitVersionControl;
  const substratePath = "/test/substrate";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    processRunner = new InMemoryProcessRunner();
    logger = new InMemoryLogger();
    git = new GitVersionControl(substratePath, processRunner, fs, logger);
    await fs.mkdir(substratePath, { recursive: true });
  });

  describe("isInitialized()", () => {
    it("returns false when .git directory does not exist", async () => {
      const initialized = await git.isInitialized();
      expect(initialized).toBe(false);
    });

    it("returns true when .git directory exists", async () => {
      await fs.mkdir(`${substratePath}/.git`, { recursive: true });
      const initialized = await git.isInitialized();
      expect(initialized).toBe(true);
    });
  });

  describe("initialize()", () => {
    it("runs git init when not initialized", async () => {
      await git.initialize();

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.command === "git" && c.args[0] === "init")).toBe(true);
    });

    it("configures git user name and email", async () => {
      await git.initialize();

      const calls = processRunner.getCalls();
      const configCalls = calls.filter((c) => c.command === "git" && c.args[0] === "config");
      
      expect(configCalls.some((c) => c.args.includes("user.name"))).toBe(true);
      expect(configCalls.some((c) => c.args.includes("user.email"))).toBe(true);
    });

    it("does not reinitialize if already initialized", async () => {
      await fs.mkdir(`${substratePath}/.git`, { recursive: true });
      await git.initialize();

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.command === "git" && c.args[0] === "init")).toBe(false);
    });
  });

  describe("hasChanges()", () => {
    it("returns false when status is clean", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "", stderr: "" });
      const hasChanges = await git.hasChanges();
      expect(hasChanges).toBe(false);
    });

    it("returns true when there are changes", async () => {
      processRunner.mockResponse("git", {
        success: true,
        stdout: " M PLAN.md\n?? new-file.md\n",
        stderr: "",
      });
      const hasChanges = await git.hasChanges();
      expect(hasChanges).toBe(true);
    });
  });

  describe("getChangedFiles()", () => {
    it("returns empty array when no changes", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "", stderr: "" });
      const files = await git.getChangedFiles();
      expect(files).toEqual([]);
    });

    it("parses changed files from git status", async () => {
      processRunner.clear();
      processRunner.mockResponse("git", {
        success: true,
        stdout: " M PLAN.md\n M MEMORY.md\n?? new-file.md\n",
        stderr: "",
      });
      const files = await git.getChangedFiles();
      expect(files).toEqual(["PLAN.md", "MEMORY.md", "new-file.md"]);
    });
  });

  describe("commitChanges()", () => {
    it("adds all changes and commits with message", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "", stderr: "" });
      
      await git.commitChanges({ message: "test commit" });

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
      expect(calls.some((c) => c.args[0] === "commit" && c.args.includes("test commit"))).toBe(true);
    });

    it("skips commit if skipIfClean=true and no changes", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "", stderr: "" });
      
      const committed = await git.commitChanges({ message: "test", skipIfClean: true });

      expect(committed).toBe(false);
      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
    });

    it("returns false when nothing to commit", async () => {
      processRunner.mockResponse("git", {
        success: false,
        stdout: "",
        stderr: "nothing to commit, working tree clean",
      });

      const committed = await git.commitChanges({ message: "test" });
      expect(committed).toBe(false);
    });
  });

  describe("getHistory()", () => {
    it("parses git log output into entries", async () => {
      processRunner.mockResponse("git", {
        success: true,
        stdout:
          "abc123|2026-02-28T12:00:00Z|Initial commit|Bishop Daemon\n" +
          "def456|2026-02-28T13:00:00Z|Update PLAN|Bishop Daemon\n",
        stderr: "",
      });

      const history = await git.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].hash).toBe("abc123");
      expect(history[0].message).toBe("Initial commit");
      expect(history[1].hash).toBe("def456");
    });

    it("returns empty array when no commits", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "", stderr: "" });
      const history = await git.getHistory();
      expect(history).toEqual([]);
    });
  });

  describe("rollback()", () => {
    it("verifies commit exists before rolling back", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "commit\n", stderr: "" });
      
      await git.rollback("abc123");

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.args[0] === "cat-file" && c.args.includes("abc123"))).toBe(true);
    });

    it("performs hard reset to commit", async () => {
      processRunner.mockResponse("git", { success: true, stdout: "commit\n", stderr: "" });
      
      await git.rollback("abc123");

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.args[0] === "reset" && c.args[1] === "--hard")).toBe(true);
    });

    it("throws error for invalid commit hash", async () => {
      processRunner.mockResponse("git", { success: false, stdout: "", stderr: "fatal" });
      
      await expect(git.rollback("invalid")).rejects.toThrow("Invalid commit hash");
    });
  });

  describe("createSnapshot()", () => {
    it("commits changes before creating snapshot", async () => {
      processRunner.mockResponse("git", {
        success: true,
        stdout: " M PLAN.md\n",
        stderr: "",
      });
      processRunner.mockResponse("git", { success: true, stdout: "abc123\n", stderr: "" });

      const hash = await git.createSnapshot("before-update");

      const calls = processRunner.getCalls();
      expect(calls.some((c) => c.args[0] === "commit")).toBe(true);
      expect(hash).toBe("abc123");
    });
  });
});
