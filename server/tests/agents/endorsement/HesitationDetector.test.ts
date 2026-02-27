import { HesitationDetector } from "../../../src/agents/endorsement/HesitationDetector";

describe("HesitationDetector", () => {
  let detector: HesitationDetector;

  beforeEach(() => {
    detector = new HesitationDetector();
  });

  describe("detect", () => {
    it("detects 'I should check with my partner'", () => {
      const result = detector.detect("I should check with my partner before doing this.");
      expect(result).not.toBeNull();
      expect(result!.context).toContain("I should check with my partner");
    });

    it("detects 'I should ask my partner'", () => {
      const result = detector.detect("I should ask my partner about this action.");
      expect(result).not.toBeNull();
    });

    it("detects 'I should verify with partner'", () => {
      const result = detector.detect("I should verify with partner before proceeding.");
      expect(result).not.toBeNull();
    });

    it("detects 'need permission'", () => {
      const result = detector.detect("I need permission to send this email.");
      expect(result).not.toBeNull();
      expect(result!.context).toContain("need permission");
    });

    it("detects 'require approval'", () => {
      const result = detector.detect("This will require approval from the user.");
      expect(result).not.toBeNull();
    });

    it("detects 'want confirmation'", () => {
      const result = detector.detect("I want confirmation before proceeding.");
      expect(result).not.toBeNull();
    });

    it("detects 'not sure if I should'", () => {
      const result = detector.detect("I'm not sure if I should do this.");
      expect(result).not.toBeNull();
    });

    it("detects 'not sure if I can'", () => {
      const result = detector.detect("I'm not sure if I can perform this action.");
      expect(result).not.toBeNull();
    });

    it("detects 'not sure if I have permission'", () => {
      const result = detector.detect("I'm not sure if I have permission to post.");
      expect(result).not.toBeNull();
    });

    it("detects 'let me ask'", () => {
      const result = detector.detect("Let me ask before continuing.");
      expect(result).not.toBeNull();
    });

    it("detects 'let me check with'", () => {
      const result = detector.detect("Let me check with the owner first.");
      expect(result).not.toBeNull();
    });

    it("detects 'let me confirm with'", () => {
      const result = detector.detect("Let me confirm with my partner.");
      expect(result).not.toBeNull();
    });

    // User-directed permission-seeking patterns
    it("detects 'Want me to file an issue'", () => {
      const result = detector.detect("Want me to file an issue and have Copilot fix it?");
      expect(result).not.toBeNull();
      expect(result!.context).toContain("Want me to file");
    });

    it("detects 'Do you want me to'", () => {
      const result = detector.detect("Do you want me to deploy this change?");
      expect(result).not.toBeNull();
    });

    it("detects 'Would you like me to'", () => {
      const result = detector.detect("Would you like me to create a PR for this?");
      expect(result).not.toBeNull();
    });

    it("detects 'like me to'", () => {
      const result = detector.detect("Would you like me to post this to Bluesky?");
      expect(result).not.toBeNull();
    });

    it("detects 'Should I'", () => {
      const result = detector.detect("Should I go ahead and file the issue?");
      expect(result).not.toBeNull();
    });

    it("detects 'Shall I'", () => {
      const result = detector.detect("Shall I proceed with the deployment?");
      expect(result).not.toBeNull();
    });

    it("detects 'should I' mid-sentence", () => {
      const result = detector.detect("I'm wondering — should I open a PR or commit directly?");
      expect(result).not.toBeNull();
    });

    it("returns null for normal text with no hesitation", () => {
      const result = detector.detect("I will now post the blog update as planned.");
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = detector.detect("");
      expect(result).toBeNull();
    });

    it("includes surrounding context in match", () => {
      const result = detector.detect(
        "The task is ready. I need permission to send. Proceeding now."
      );
      expect(result).not.toBeNull();
      expect(result!.context).toContain("I need permission to send");
    });

    it("is case-insensitive", () => {
      const result = detector.detect("I SHOULD CHECK WITH MY PARTNER about this.");
      expect(result).not.toBeNull();
    });

    it("returns the pattern source in the match", () => {
      const result = detector.detect("I need permission to continue.");
      expect(result).not.toBeNull();
      expect(typeof result!.pattern).toBe("string");
    });

    it("accepts custom patterns", () => {
      const custom = new HesitationDetector([/please (advise|confirm)/i]);
      const result = custom.detect("Please advise on how to proceed.");
      expect(result).not.toBeNull();
    });

    it("does not trigger on custom patterns it was not given", () => {
      const custom = new HesitationDetector([/please (advise|confirm)/i]);
      const result = custom.detect("I need permission for this.");
      expect(result).toBeNull();
    });
  });
});
