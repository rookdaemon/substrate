import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SurvivalModelPolicyLauncher } from "../../src/agents/SurvivalModelPolicyLauncher";

describe("SurvivalModelPolicyLauncher", () => {
  it("downgrades default frontier Codex model to low-cost model without explicit opt-in", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "codex",
      defaultModel: "gpt-5.5",
    });

    await launcher.launch({ systemPrompt: "", message: "run" }, {
      usageContext: { role: "EGO", operation: "decide" },
    });

    expect(inner.getLaunches()[0].options?.model).toBe("gpt-5.4-mini");
  });

  it("uses non-frontier model for Subconscious when a frontier model is requested", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "claude",
      defaultModel: "claude-opus-4-6",
    });

    await launcher.launch({ systemPrompt: "", message: "run" }, {
      model: "claude-opus-4-6",
      usageContext: { role: "SUBCONSCIOUS", operation: "evaluateOutcome" },
    });

    expect(inner.getLaunches()[0].options?.model).toBe("claude-sonnet-4-6");
  });

  it("allows frontier models only when the launch opts in explicitly", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "codex",
      defaultModel: "gpt-5.4-mini",
    });

    await launcher.launch({ systemPrompt: "", message: "run" }, {
      model: "gpt-5.5",
      allowFrontierModel: true,
      usageContext: { role: "EGO", operation: "decide" },
    });

    expect(inner.getLaunches()[0].options?.model).toBe("gpt-5.5");
  });

  it("allows operator-configured frontier models when configured-frontier opt-in is set", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "codex",
      defaultModel: "gpt-5.5",
      configuredFrontierModels: ["gpt-5.5"],
      allowConfiguredFrontierModels: true,
    });

    await launcher.launch({ systemPrompt: "", message: "run" }, {
      model: "gpt-5.5",
      usageContext: { role: "SUBCONSCIOUS", operation: "execute" },
    });

    expect(inner.getLaunches()[0].options?.model).toBe("gpt-5.5");
  });

  it("sets provider low-cost model for unmodeled dispatches", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "vertex",
    });

    await launcher.launch({ systemPrompt: "", message: "run" });

    expect(inner.getLaunches()[0].options?.model).toBe("gemini-2.5-flash");
  });

  it("uses provider low-cost model when global defaults belong to another provider", async () => {
    const inner = new InMemorySessionLauncher();
    inner.enqueueSuccess("ok");
    const launcher = new SurvivalModelPolicyLauncher(inner, {
      provider: "codex",
      defaultModel: "claude-haiku-4-5",
    });

    await launcher.launch({ systemPrompt: "", message: "run" }, {
      usageContext: { role: "SUBCONSCIOUS", operation: "execute" },
    });

    expect(inner.getLaunches()[0].options?.model).toBe("gpt-5.4-mini");
  });
});
