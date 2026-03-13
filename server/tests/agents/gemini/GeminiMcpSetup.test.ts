import { GeminiMcpSetup } from "../../../src/agents/gemini/GeminiMcpSetup";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { InMemoryLogger } from "../../../src/logging";

const MCP_URL = "http://localhost:3000/mcp";
const SERVER_NAME = "tinybus";

function makeSetup(): { runner: InMemoryProcessRunner; setup: GeminiMcpSetup } {
  const runner = new InMemoryProcessRunner();
  const logger = new InMemoryLogger();
  const setup = new GeminiMcpSetup(runner, logger);
  return { runner, setup };
}

describe("GeminiMcpSetup", () => {
  it("calls gemini mcp remove then gemini mcp add with server name and URL", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // remove
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // add

    await setup.register(SERVER_NAME, MCP_URL);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(2);

    expect(calls[0].command).toBe("gemini");
    expect(calls[0].args).toEqual(["mcp", "remove", SERVER_NAME, "-y"]);

    expect(calls[1].command).toBe("gemini");
    expect(calls[1].args).toEqual(["mcp", "add", SERVER_NAME, "--url", MCP_URL]);
  });

  it("still calls add even when remove throws (not yet registered)", async () => {
    const { runner, setup } = makeSetup();
    // No response enqueued for remove → InMemoryProcessRunner throws
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // add

    // remove throws because no response enqueued
    await setup.register(SERVER_NAME, MCP_URL);

    const calls = runner.getCalls();
    // remove was attempted (threw), then add was called
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("add");
  });

  it("still calls add when remove returns non-zero exit code", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "not found", exitCode: 1 }); // remove fails
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // add

    await setup.register(SERVER_NAME, MCP_URL);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("add");
  });

  it("does not throw when add fails", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // remove
    // No add response → throws inside register

    await expect(setup.register(SERVER_NAME, MCP_URL)).resolves.not.toThrow();
  });

  it("passes any server name and URL to gemini mcp add", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // remove
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // add

    await setup.register("myserver", "http://localhost:9999/mcp");

    const addCall = runner.getCalls()[1];
    expect(addCall.args).toContain("myserver");
    expect(addCall.args).toContain("http://localhost:9999/mcp");
  });
});
