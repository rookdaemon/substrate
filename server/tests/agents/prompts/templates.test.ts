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

    it("explains substrate context is pre-loaded", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toMatch(/SUBSTRATE CONTEXT/i);
    });

    it("instructs to write concrete progress entries", () => {
      const prompt = ROLE_PROMPTS[AgentRole.SUBCONSCIOUS];
      expect(prompt).toMatch(/progress/i);
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
  });
});
