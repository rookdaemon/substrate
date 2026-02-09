import {
  IProcessRunner,
  ProcessResult,
} from "../../../src/agents/claude/IProcessRunner";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";

describe("IProcessRunner interface", () => {
  it("can be satisfied by InMemoryProcessRunner", () => {
    const runner: IProcessRunner = new InMemoryProcessRunner();
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe("function");
  });
});

describe("InMemoryProcessRunner", () => {
  let runner: InMemoryProcessRunner;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
  });

  it("returns enqueued responses in order", async () => {
    runner.enqueue({ stdout: "first", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "second", stderr: "", exitCode: 0 });

    const r1 = await runner.run("cmd", ["a"]);
    const r2 = await runner.run("cmd", ["b"]);

    expect(r1.stdout).toBe("first");
    expect(r2.stdout).toBe("second");
  });

  it("throws when no responses are enqueued", async () => {
    await expect(runner.run("cmd", [])).rejects.toThrow(
      "No more canned responses"
    );
  });

  it("records all calls for assertions", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });
    await runner.run("claude", ["--print", "hello"]);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args).toEqual(["--print", "hello"]);
  });

  it("records multiple calls", async () => {
    runner.enqueue({ stdout: "a", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "b", stderr: "", exitCode: 0 });

    await runner.run("cmd1", ["x"]);
    await runner.run("cmd2", ["y"]);

    expect(runner.getCalls()).toHaveLength(2);
  });

  it("can return non-zero exit codes", async () => {
    runner.enqueue({ stdout: "", stderr: "error!", exitCode: 1 });

    const result = await runner.run("fail", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error!");
  });

  it("passes options through to recorded calls", async () => {
    runner.enqueue({ stdout: "ok", stderr: "", exitCode: 0 });
    await runner.run("cmd", [], { timeoutMs: 5000 });

    const calls = runner.getCalls();
    expect(calls[0].options).toEqual({ timeoutMs: 5000 });
  });

  it("can be reset to clear calls and responses", () => {
    runner.enqueue({ stdout: "a", stderr: "", exitCode: 0 });
    runner.reset();
    expect(runner.getCalls()).toHaveLength(0);
  });

  it("calls onStdout with stdout content before resolving", async () => {
    runner.enqueue({ stdout: "hello world", stderr: "", exitCode: 0 });
    const chunks: string[] = [];

    await runner.run("cmd", [], { onStdout: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["hello world"]);
  });

  it("does not call onStdout when callback is not provided", async () => {
    runner.enqueue({ stdout: "hello", stderr: "", exitCode: 0 });

    const result = await runner.run("cmd", []);
    expect(result.stdout).toBe("hello");
  });

  it("does not call onStdout when stdout is empty", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    const chunks: string[] = [];

    await runner.run("cmd", [], { onStdout: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual([]);
  });
});

describe("ProcessResult", () => {
  it("has stdout, stderr, exitCode fields", () => {
    const result: ProcessResult = {
      stdout: "output",
      stderr: "warnings",
      exitCode: 0,
    };
    expect(result.stdout).toBe("output");
    expect(result.stderr).toBe("warnings");
    expect(result.exitCode).toBe(0);
  });
});
