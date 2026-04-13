import { detectAuthorityInversion } from "../../../src/agents/parsers/AuthorityInversionDetector";

describe("AuthorityInversionDetector", () => {
  describe("non-PLAN targets", () => {
    it("does not flag proposals targeting HABITS", () => {
      const result = detectAuthorityInversion({
        target: "HABITS",
        content: "Move this habit to PROGRESS.md",
      });
      expect(result.inverted).toBe(false);
    });

    it("does not flag proposals targeting SECURITY", () => {
      const result = detectAuthorityInversion({
        target: "SECURITY",
        content: "Replace with pointer to memory/security.md",
      });
      expect(result.inverted).toBe(false);
    });

    it("does not flag proposals targeting MEMORY", () => {
      const result = detectAuthorityInversion({
        target: "MEMORY",
        content: "PLAN.md is too long — archive old sections",
      });
      expect(result.inverted).toBe(false);
    });
  });

  describe("subtractive subtype", () => {
    it("detects 'move to PROGRESS' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "Move completed tasks to PROGRESS.md to reduce noise in PLAN.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
      expect(result.reason).toContain("AUTHORITY INVERSION (subtractive)");
    });

    it("detects 'belongs in memory/' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "This section belongs in memory/architecture.md — remove it from PLAN.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("detects 'PLAN.md is too long' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "PLAN.md is too long. Condense historical context into PROGRESS.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("detects 'move ... out of PLAN' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "Relocate old architecture notes out of PLAN to memory/.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("detects 'remove ... from PLAN' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "Remove completed milestone entries from PLAN to keep it lean.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("detects 'trim PLAN' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "Trim PLAN by archiving low-priority background tasks.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("detects 'migrate ... from PLAN' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Migrate historical context from PLAN into the memory/ subdirectory.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });

    it("is case-insensitive for target", () => {
      const result = detectAuthorityInversion({
        target: "plan",
        content: "Move old goals to PROGRESS.md.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("subtractive");
    });
  });

  describe("reference-replacing subtype", () => {
    it("detects 'replace with pointer' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Replace the architecture section with a pointer to memory/arch.md.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("reference-replacing");
      expect(result.reason).toContain("AUTHORITY INVERSION (reference-replacing)");
    });

    it("detects 'replace with reference' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Replace the background tasks with a reference to PROGRESS.md for historical detail.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("reference-replacing");
    });

    it("detects 'pointer to PROGRESS' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Keep only a pointer to PROGRESS for completed items; remove inline detail.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("reference-replacing");
    });

    it("detects 'replace sections with pointer' pattern", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "Replace completed sections with pointer to archived records.",
      });
      expect(result.inverted).toBe(true);
      expect(result.subtype).toBe("reference-replacing");
    });
  });

  describe("additive / legitimate PLAN edits (no inversion)", () => {
    it("does not flag adding a new task to PLAN", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content: "- [ ] Implement rate-limit retry with exponential backoff",
      });
      expect(result.inverted).toBe(false);
      expect(result.subtype).toBeUndefined();
    });

    it("does not flag refining an existing task description", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Refine task: 'Improve error handling' — add acceptance criteria for each error type.",
      });
      expect(result.inverted).toBe(false);
    });

    it("does not flag adding a governance section to PLAN", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "## Governance\n\nAdd recurring Superego audit schedule to PLAN.",
      });
      expect(result.inverted).toBe(false);
    });

    it("does not flag clarifying PLAN goals inline", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Clarify current goal: ship memory consolidation milestone by end of sprint.",
      });
      expect(result.inverted).toBe(false);
    });

    it("does not flag adding reference to existing memory entry without subtracting from PLAN", () => {
      const result = detectAuthorityInversion({
        target: "PLAN",
        content:
          "Add cross-reference annotation: see memory/arch.md for implementation notes.",
      });
      expect(result.inverted).toBe(false);
    });
  });
});
