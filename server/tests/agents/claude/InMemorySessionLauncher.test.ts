import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { ProcessLogEntry } from "../../../src/agents/claude/ISessionLauncher";

describe("InMemorySessionLauncher", () => {
  let launcher: InMemorySessionLauncher;

  beforeEach(() => {
    launcher = new InMemorySessionLauncher();
  });

  describe("enqueueSuccess", () => {
    it("returns a successful result with the given rawOutput", async () => {
      launcher.enqueueSuccess('{"action":"idle"}');

      const result = await launcher.launch({
        systemPrompt: "You are a bot",
        message: "Do something",
      });

      expect(result.success).toBe(true);
      expect(result.rawOutput).toBe('{"action":"idle"}');
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe("enqueueFailure", () => {
    it("returns a failed result with the given error", async () => {
      launcher.enqueueFailure("rate limited");

      const result = await launcher.launch({
        systemPrompt: "prompt",
        message: "msg",
      });

      expect(result.success).toBe(false);
      expect(result.rawOutput).toBe("");
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe("rate limited");
    });
  });

  describe("enqueue", () => {
    it("returns the exact result provided", async () => {
      launcher.enqueue({
        rawOutput: "custom",
        exitCode: 42,
        durationMs: 100,
        success: false,
        error: "custom error",
      });

      const result = await launcher.launch({
        systemPrompt: "prompt",
        message: "msg",
      });

      expect(result.rawOutput).toBe("custom");
      expect(result.exitCode).toBe(42);
      expect(result.durationMs).toBe(100);
      expect(result.success).toBe(false);
      expect(result.error).toBe("custom error");
    });
  });

  describe("getLaunches", () => {
    it("records request and options for each launch", async () => {
      launcher.enqueueSuccess("ok");

      await launcher.launch(
        { systemPrompt: "sys", message: "msg" },
        { cwd: "/workspace", maxRetries: 3 }
      );

      const launches = launcher.getLaunches();
      expect(launches).toHaveLength(1);
      expect(launches[0].request.systemPrompt).toBe("sys");
      expect(launches[0].request.message).toBe("msg");
      expect(launches[0].options?.cwd).toBe("/workspace");
      expect(launches[0].options?.maxRetries).toBe(3);
    });
  });

  describe("ordering", () => {
    it("dequeues results in FIFO order", async () => {
      launcher.enqueueSuccess("first");
      launcher.enqueueSuccess("second");

      const r1 = await launcher.launch({ systemPrompt: "", message: "" });
      const r2 = await launcher.launch({ systemPrompt: "", message: "" });

      expect(r1.rawOutput).toBe("first");
      expect(r2.rawOutput).toBe("second");
    });

    it("throws when no results are enqueued", async () => {
      await expect(
        launcher.launch({ systemPrompt: "", message: "" })
      ).rejects.toThrow("No more canned responses");
    });
  });

  describe("reset", () => {
    it("clears enqueued responses and recorded launches", async () => {
      launcher.enqueueSuccess("ok");
      await launcher.launch({ systemPrompt: "", message: "" });

      launcher.reset();

      expect(launcher.getLaunches()).toHaveLength(0);
      await expect(
        launcher.launch({ systemPrompt: "", message: "" })
      ).rejects.toThrow();
    });
  });

  describe("onLogEntry callback", () => {
    it("does not call onLogEntry by default", async () => {
      launcher.enqueueSuccess("ok");
      const entries: ProcessLogEntry[] = [];

      await launcher.launch(
        { systemPrompt: "", message: "" },
        { onLogEntry: (e) => entries.push(e) }
      );

      expect(entries).toHaveLength(0);
    });
  });
});
