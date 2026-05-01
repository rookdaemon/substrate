import { ROLE_PROMPTS } from "../../../src/agents/prompts/templates";
import { AgentRole } from "../../../src/agents/types";

describe("ROLE_PROMPTS", () => {
  it("defines a prompt for every AgentRole", () => {
    for (const role of Object.values(AgentRole)) {
      expect(ROLE_PROMPTS[role]).toBeDefined();
      expect(typeof ROLE_PROMPTS[role]).toBe("string");
      expect(ROLE_PROMPTS[role].length).toBeGreaterThan(0);
    }
  });

  describe("Ego prompt", () => {
    it("contains role identity", () => {
      expect(ROLE_PROMPTS[AgentRole.EGO]).toContain("Ego");
    });

    it("instructs JSON output", () => {
      expect(ROLE_PROMPTS[AgentRole.EGO]).toContain("JSON");
    });

    it("describes executive decision-making", () => {
      const prompt = ROLE_PROMPTS[AgentRole.EGO];
      expect(prompt).toMatch(/plan|dispatch|decide/i);
    });

    it("includes an identity continuity veto", () => {
      const prompt = ROLE_PROMPTS[AgentRole.EGO];
      expect(prompt).toContain("Preserve identity continuity");
      expect(prompt).toMatch(/Veto actions.*erode the agent's established personality/i);
    });

    it("treats processed conversation entries as transcript, not new work", () => {
      const prompt = ROLE_PROMPTS[AgentRole.EGO];
      expect(prompt).toContain("[PROCESSED");
      expect(prompt).toMatch(/must NOT be handled again/i);
    });
  });

  describe("Subconscious prompt", () => {
    it("contains role identity", () => {
      expect(ROLE_PROMPTS[AgentRole.SUBCONSCIOUS]).toContain("Subconscious");
    });

    it("instructs JSON output", () => {
      expect(ROLE_PROMPTS[AgentRole.SUBCONSCIOUS]).toContain("JSON");
    });

    it("describes task execution", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toMatch(/execute|task|work/i);
    });

    it("explains substrate files are attached via @ references", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toMatch(/@ references/i);
    });

    it("instructs to write concrete progress entries", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toMatch(/progress/i);
    });

    it("separates external IO from operating context", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toContain("CONVERSATION.md is for external IO");
      expect(prompt).toContain("OPERATING_CONTEXT.md");
      expect(prompt).toContain("PROGRESS.md is durable execution history");
    });
  });

  describe("Superego prompt", () => {
    it("contains role identity", () => {
      expect(ROLE_PROMPTS[AgentRole.SUPEREGO]).toContain("Superego");
    });

    it("instructs JSON output", () => {
      expect(ROLE_PROMPTS[AgentRole.SUPEREGO]).toContain("JSON");
    });

    it("describes auditing and governance", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toMatch(/audit|govern|review/i);
    });

    it("includes scope rule: domain/target determines governance, not output type", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toContain("domain/target");
      expect(prompt).toContain("SCOPE_BYPASS_ATTEMPT");
    });

    it("includes VALUES-RECRUITMENT pattern warning", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toContain("VALUES-RECRUITMENT");
    });

    it("lists scope bypass phrases that do not exempt from governance", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toMatch(/internal reasoning/i);
      expect(prompt).toMatch(/no file modifications/i);
      expect(prompt).toMatch(/cognitive.only/i);
    });

    it("prioritizes identity continuity between security and cost", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toContain("Security > Identity/Personality Continuity > Cost > Availability");
      expect(prompt.indexOf("IDENTITY / PERSONALITY CONTINUITY")).toBeGreaterThan(
        prompt.indexOf("SECURITY")
      );
      expect(prompt.indexOf("TOKEN & COST OPTIMIZATION")).toBeGreaterThan(
        prompt.indexOf("IDENTITY / PERSONALITY CONTINUITY")
      );
    });

    it("includes identity and provider-switch finding categories", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUPEREGO];
      expect(prompt).toContain("IDENTITY_CONTINUITY_RISK");
      expect(prompt).toContain("PROVIDER_SWITCH_DRIFT");
    });
  });

  describe("Id prompt", () => {
    it("contains role identity", () => {
      expect(ROLE_PROMPTS[AgentRole.ID]).toContain("Id");
    });

    it("instructs JSON output", () => {
      expect(ROLE_PROMPTS[AgentRole.ID]).toContain("JSON");
    });

    it("describes drive and motivation", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/drive|motiv|goal|idle/i);
    });

    it("includes task-mandate self-check covering mandate consistency", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/task.mandate self-check/i);
      expect(prompt).toMatch(/mandate/i);
    });

    it("includes task-mandate self-check covering deduplication against in-progress goals", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/duplicate|duplicates/i);
      expect(prompt).toMatch(/in.progress/i);
    });

    it("includes performed-disagreement rule for explicit dissent surfacing", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/performed-disagreement/i);
      expect(prompt).toMatch(/disagreement candidate/i);
    });

    it("contains same-model operating caveat", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/same base model/i);
      expect(prompt).toMatch(/echo.chamber|homogeneity/i);
    });

    it("instructs Id to generate diverse candidates as countermeasure", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toMatch(/diverse/i);
      expect(prompt).toMatch(/breadth/i);
      expect(prompt).toMatch(/Ego will filter/i);
    });

    it("grounds goals in durable identity and operating context", () => {
      const prompt = ROLE_PROMPTS[AgentRole.ID];
      expect(prompt).toContain("Ground candidate goals in durable identity");
      expect(prompt).toContain("ID.md");
      expect(prompt).toContain("VALUES.md");
      expect(prompt).toContain("OPERATING_CONTEXT.md");
    });
  });
});
