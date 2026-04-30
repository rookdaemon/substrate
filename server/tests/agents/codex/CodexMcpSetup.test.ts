import { CodexMcpSetup } from "../../../src/agents/codex/CodexMcpSetup";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { InMemoryLogger } from "../../../src/logging";

const MCP_URL = "http://localhost:3000/mcp";
const SERVER_NAME = "tinybus";

function makeSetup(): { runner: InMemoryProcessRunner; setup: CodexMcpSetup } {
  const runner = new InMemoryProcessRunner();
  const logger = new InMemoryLogger();
  const setup = new CodexMcpSetup(runner, logger);
  return { runner, setup };
}

describe("CodexMcpSetup", () => {
  it("calls codex mcp remove then codex mcp add with server name and URL", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await setup.register(SERVER_NAME, MCP_URL);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(2);

    expect(calls[0].command).toBe("codex");
    expect(calls[0].args).toEqual(["mcp", "remove", SERVER_NAME]);

    expect(calls[1].command).toBe("codex");
    expect(calls[1].args).toEqual(["mcp", "add", SERVER_NAME, "--url", MCP_URL]);
  });

  it("still calls add even when remove throws", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await setup.register(SERVER_NAME, MCP_URL);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("add");
  });

  it("does not throw when add fails", async () => {
    const { runner, setup } = makeSetup();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await expect(setup.register(SERVER_NAME, MCP_URL)).resolves.not.toThrow();
  });
});
