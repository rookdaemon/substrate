import { CodexSessionLauncher } from "../../../src/agents/codex/CodexSessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

function makeRequest(overrides?: Partial<ClaudeSessionRequest>): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Hello, world!",
    ...overrides,
  };
}

describe("CodexSessionLauncher", () => {
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let launcher: CodexSessionLauncher;

  beforeEach(() => {
    runner = new InMemoryProcessRunner();
    clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
    launcher = new CodexSessionLauncher(runner, clock);
  });

  it("invokes codex exec with headless automatic flags", async () => {
    runner.enqueue({ stdout: "response", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "Do something" }));

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].args.slice(0, 2)).toEqual(["exec", "--full-auto"]);
    expect(calls[0].args).toContain("--color");
    expect(calls[0].args).toContain("never");
    expect(calls[0].args).toContain("--skip-git-repo-check");
  });

  it("omits model flag when no model is provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest());

    expect(runner.getCalls()[0].args).not.toContain("-m");
  });

  it("omits default Claude model names so Codex can use its configured default", async () => {
    const codexLauncher = new CodexSessionLauncher(runner, clock, "claude-sonnet-4-6");
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await codexLauncher.launch(makeRequest(), { model: "claude-opus-4-6" });

    expect(runner.getCalls()[0].args).not.toContain("-m");
  });

  it("uses custom Codex model when provided via options", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { model: "gpt-5.2" });

    const args = runner.getCalls()[0].args;
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gpt-5.2");
  });

  it("prepends system prompt to the message when systemPrompt is provided", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({
      systemPrompt: "You are a helpful assistant.",
      message: "What is 2+2?",
    }));

    const prompt = runner.getCalls()[0].args.at(-1);
    expect(prompt).toContain("SYSTEM INSTRUCTIONS:");
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt).toContain("What is 2+2?");
  });

  it("does not prepend system section when systemPrompt is empty", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    expect(runner.getCalls()[0].args.at(-1)).toBe("Hello");
  });

  it("passes cwd as -C and as process cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/my/workspace" });

    const call = runner.getCalls()[0];
    expect(call.args).toContain("-C");
    expect(call.args[call.args.indexOf("-C") + 1]).toBe("/my/workspace");
    expect(call.options?.cwd).toBe("/my/workspace");
  });

  it("passes each additionalDir as --add-dir", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { additionalDirs: ["/source/root", "/extra/dir"] });

    const args = runner.getCalls()[0].args;
    const addDirIndices = args.reduce<number[]>((acc, arg, i) => (arg === "--add-dir" ? [...acc, i] : acc), []);
    const addDirValues = addDirIndices.map((i) => args[i + 1]);
    expect(addDirValues).toEqual(["/source/root", "/extra/dir"]);
  });

  it("starts a new codex exec session on the first continueSession call for a cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    await launcher.launch(makeRequest(), { cwd: "/workspace/ego", continueSession: true });

    expect(runner.getCalls()[0].args.slice(0, 2)).toEqual(["exec", "--full-auto"]);
  });

  it("uses codex exec resume --last after a cwd session has started", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest({ message: "first" }), { cwd: "/workspace/ego", continueSession: true });
    await launcher.launch(makeRequest({ message: "second" }), { cwd: "/workspace/ego", continueSession: true });

    expect(runner.getCalls()[1].args.slice(0, 4)).toEqual(["exec", "resume", "--last", "--full-auto"]);
    expect(runner.getCalls()[1].args.at(-1)).toBe("second");
  });

  it("keeps resume state isolated by cwd", async () => {
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await launcher.launch(makeRequest(), { cwd: "/workspace/ego", continueSession: true });
    await launcher.launch(makeRequest(), { cwd: "/workspace/id", continueSession: true });

    expect(runner.getCalls()[1].args.slice(0, 2)).toEqual(["exec", "--full-auto"]);
  });

  it("returns success=true and rawOutput on exit code 0", async () => {
    runner.enqueue({ stdout: "final output", stderr: "", exitCode: 0 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("final output");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("returns success=false on non-zero exit code", async () => {
    runner.enqueue({ stdout: "", stderr: "something went wrong", exitCode: 1 });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("something went wrong");
  });

  it("returns success=false with error message when process runner throws", async () => {
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });
});
