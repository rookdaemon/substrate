import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { AgentRole } from "../../src/agents/types";

describe("TaskClassifier", () => {
  let classifier: TaskClassifier;

  beforeEach(() => {
    classifier = new TaskClassifier({
      strategicModel: "opus",
      tacticalModel: "sonnet",
    });
  });

  describe("classify", () => {
    it("classifies Ego.decide as strategic", () => {
      const result = classifier.classify({
        role: AgentRole.EGO,
        operation: "decide",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Ego.respondToMessage as strategic", () => {
      const result = classifier.classify({
        role: AgentRole.EGO,
        operation: "respondToMessage",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Id.generateDrives as strategic", () => {
      const result = classifier.classify({
        role: AgentRole.ID,
        operation: "generateDrives",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Superego.audit as strategic", () => {
      const result = classifier.classify({
        role: AgentRole.SUPEREGO,
        operation: "audit",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Subconscious.evaluateOutcome as strategic", () => {
      const result = classifier.classify({
        role: AgentRole.SUBCONSCIOUS,
        operation: "evaluateOutcome",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Subconscious.execute as strategic (real work deserves the strategic model)", () => {
      const result = classifier.classify({
        role: AgentRole.SUBCONSCIOUS,
        operation: "execute",
      });
      expect(result).toBe("strategic");
    });

    it("classifies Superego.evaluateProposals as tactical", () => {
      const result = classifier.classify({
        role: AgentRole.SUPEREGO,
        operation: "evaluateProposals",
      });
      expect(result).toBe("tactical");
    });

    it("classifies Id.detectIdle as tactical", () => {
      const result = classifier.classify({
        role: AgentRole.ID,
        operation: "detectIdle",
      });
      expect(result).toBe("tactical");
    });

    it("classifies unknown operations as strategic (safe default)", () => {
      const result = classifier.classify({
        role: AgentRole.EGO,
        operation: "unknownOperation",
      });
      expect(result).toBe("strategic");
    });
  });

  describe("getModel", () => {
    it("returns opus for strategic operations", () => {
      const model = classifier.getModel({
        role: AgentRole.EGO,
        operation: "decide",
      });
      expect(model).toBe("opus");
    });

    it("returns sonnet for tactical operations", () => {
      const model = classifier.getModel({
        role: AgentRole.SUPEREGO,
        operation: "evaluateProposals",
      });
      expect(model).toBe("sonnet");
    });

    it("returns opus for Subconscious.execute (moved to strategic)", () => {
      const model = classifier.getModel({
        role: AgentRole.SUBCONSCIOUS,
        operation: "execute",
      });
      expect(model).toBe("opus");
    });

    it("uses custom model names from config", () => {
      const customClassifier = new TaskClassifier({
        strategicModel: "claude-fable-5",
        tacticalModel: "claude-sonnet-4-6",
      });

      expect(customClassifier.getModel({
        role: AgentRole.EGO,
        operation: "decide",
      })).toBe("claude-fable-5");

      expect(customClassifier.getModel({
        role: AgentRole.SUBCONSCIOUS,
        operation: "execute",
      })).toBe("claude-fable-5");
    });
  });

  describe("getClassificationReason", () => {
    it("provides explanation for strategic classification", () => {
      const reason = classifier.getClassificationReason({
        role: AgentRole.EGO,
        operation: "decide",
      });
      expect(reason).toContain("opus");
      expect(reason).toContain("strategic");
      expect(reason).toContain("decide");
      expect(reason).toContain("EGO");
      expect(reason).toContain("deep reasoning");
    });

    it("provides explanation for tactical classification", () => {
      const reason = classifier.getClassificationReason({
        role: AgentRole.SUPEREGO,
        operation: "evaluateProposals",
      });
      expect(reason).toContain("sonnet");
      expect(reason).toContain("tactical");
      expect(reason).toContain("evaluateProposals");
      expect(reason).toContain("SUPEREGO");
      expect(reason).toContain("routine");
    });
  });

  describe("operation coverage", () => {
    it("handles all strategic operations including Subconscious.execute", () => {
      const strategicOps = [
        { role: AgentRole.SUBCONSCIOUS, operation: "execute" },
        { role: AgentRole.EGO, operation: "decide" },
        { role: AgentRole.EGO, operation: "respondToMessage" },
        { role: AgentRole.ID, operation: "generateDrives" },
        { role: AgentRole.SUPEREGO, operation: "audit" },
        { role: AgentRole.SUBCONSCIOUS, operation: "evaluateOutcome" },
      ];

      strategicOps.forEach(op => {
        expect(classifier.classify(op)).toBe("strategic");
        expect(classifier.getModel(op)).toBe("opus");
      });
    });

    it("handles all tactical operations", () => {
      const tacticalOps = [
        { role: AgentRole.SUPEREGO, operation: "evaluateProposals" },
        { role: AgentRole.ID, operation: "detectIdle" },
        { role: AgentRole.EGO, operation: "dispatchNext" },
      ];

      tacticalOps.forEach(op => {
        expect(classifier.classify(op)).toBe("tactical");
        expect(classifier.getModel(op)).toBe("sonnet");
      });
    });
  });
});
