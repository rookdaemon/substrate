import { ClaudeSessionLauncher } from "../../../src/agents/claude/ClaudeSessionLauncher";
import { ISessionLauncher } from "../../../src/agents/claude/ISessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

describe("ISessionLauncher", () => {
  it("ClaudeSessionLauncher satisfies the interface", () => {
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-01-01T00:00:00.000Z"));
    const launcher: ISessionLauncher = new ClaudeSessionLauncher(runner, clock);
    expect(launcher).toBeDefined();
    expect(typeof launcher.launch).toBe("function");
  });
});
