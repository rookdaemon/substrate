import { IterationPlanner } from "../../src/agents/IterationPlanner";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { SubstrateConfig } from "../../src/substrate/config";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { InMemoryLogger } from "../../src/logging";

async function makePlanner() {
  const fs = new InMemoryFileSystem();
  const config = new SubstrateConfig("/substrate");
  const reader = new SubstrateFileReader(fs, config);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker, {
    substratePath: "/substrate",
    sourceCodePath: "/repo",
  });
  const launcher = new InMemorySessionLauncher();
  const logger = new InMemoryLogger();

  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Add dual prompt support");
  await fs.writeFile("/substrate/VALUES.md", "# Values\n\nShip carefully");
  await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
  await fs.writeFile("/substrate/OPERATING_CONTEXT.md", "# Operating Context\n\n");

  const planner = new IterationPlanner(
    promptBuilder,
    launcher,
    {
      enabled: true,
      plannerModel: "claude-haiku",
      plannerEffort: "minimal",
      maxFanout: 2,
      modelClasses: {
        strategic: { model: "claude-opus", effort: "high" },
        everyday: { model: "claude-sonnet", effort: "medium" },
        menial: { model: "claude-haiku", effort: "minimal" },
      },
    },
    logger,
    "/workspace/ego",
    "/repo",
  );

  return { planner, launcher, logger };
}

describe("IterationPlanner", () => {
  it("prompts for direct-by-default planning and forbids reconciliation assignments", async () => {
    const { planner, launcher } = await makePlanner();
    launcher.enqueueSuccess(JSON.stringify({
      mode: "direct",
      reason: "Tiny docs edit",
      assignments: [{ id: "task-1", description: "Fix typo", modelClass: "menial" }],
    }));

    await planner.plan({ taskId: "task-1", description: "Fix typo" });

    const launches = launcher.getLaunches();
    expect(launches[0].options?.model).toBe("claude-haiku");
    expect(launches[0].options?.effort).toBe("minimal");
    expect(launches[0].request.message).toContain('Default to "direct"');
    expect(launches[0].request.message).toContain("Use \"menial\" for trivial, routine, or deterministic work");
    expect(launches[0].request.message).toContain("Do not create a reconciling");
    expect(launches[0].request.message).toContain("If reconciliation is actually required, choose \"direct\"");
  });

  it("normalizes direct menial work with configured model and effort", async () => {
    const { planner, launcher } = await makePlanner();
    launcher.enqueueSuccess(JSON.stringify({
      mode: "direct",
      reason: "The next action is obvious",
      assignments: [{ id: "task-1", description: "Run the requested test", modelClass: "menial" }],
    }));

    const plan = await planner.plan({ taskId: "task-1", description: "Run tests" });

    expect(plan.mode).toBe("direct");
    expect(plan.assignments).toEqual([{
      taskId: "task-1",
      description: "Run the requested test",
      modelClass: "menial",
      model: "claude-haiku",
      effort: "minimal",
    }]);
  });

  it("caps fanout assignments and applies per-assignment effort overrides", async () => {
    const { planner, launcher } = await makePlanner();
    launcher.enqueueSuccess(JSON.stringify({
      mode: "fanout",
      reason: "Independent workstreams",
      assignments: [
        { id: "task-1.a", description: "Audit config", modelClass: "strategic", effort: "xhigh" },
        { id: "task-1.b", description: "Update tests", modelClass: "everyday" },
        { id: "task-1.c", description: "Format docs", modelClass: "menial" },
      ],
    }));

    const plan = await planner.plan({ taskId: "task-1", description: "Do several independent things" });

    expect(plan.mode).toBe("fanout");
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments[0]).toMatchObject({
      taskId: "task-1.a",
      modelClass: "strategic",
      model: "claude-opus",
      effort: "xhigh",
    });
    expect(plan.assignments[1]).toMatchObject({
      taskId: "task-1.b",
      modelClass: "everyday",
      model: "claude-sonnet",
      effort: "medium",
    });
  });

  it("falls back to direct execution when planner session fails", async () => {
    const { planner, launcher, logger } = await makePlanner();
    launcher.enqueueFailure("rate limited");

    const plan = await planner.plan({ taskId: "task-1", description: "Implement change" });

    expect(plan.mode).toBe("direct");
    expect(plan.assignments[0]).toMatchObject({
      taskId: "task-1",
      description: "Implement change",
      modelClass: "everyday",
    });
    expect(logger.getWarnEntries()[0]).toContain("iteration planner failed");
  });
});
