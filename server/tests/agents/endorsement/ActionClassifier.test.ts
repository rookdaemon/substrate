import { ActionClassifier } from "../../../src/agents/endorsement/ActionClassifier";
import { ProcessLogEntry } from "../../../src/agents/claude/ISessionLauncher";

function toolEntry(content: string): ProcessLogEntry {
  return { type: "tool_use", content };
}

function textEntry(content: string): ProcessLogEntry {
  return { type: "text", content };
}

describe("ActionClassifier", () => {
  let classifier: ActionClassifier;

  beforeEach(() => {
    classifier = new ActionClassifier();
  });

  describe("classifyFromLogEntries", () => {
    it("returns null when no entries provided", () => {
      expect(classifier.classifyFromLogEntries([])).toBeNull();
    });

    it("returns null when only text entries present", () => {
      expect(classifier.classifyFromLogEntries([textEntry("some output")])).toBeNull();
    });

    it("detects agora send via mcp__tinybus__send_message", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry('{"tool":"mcp__tinybus__send_message","args":{}}'),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("agora_send");
      expect(result!.isExternal).toBe(true);
    });

    it("detects agora send via bare send_message (Gemini CLI)", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry('{"tool":"send_message","args":{}}'),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("agora_send");
      expect(result!.isExternal).toBe(true);
    });

    it("detects email sending", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry('{"tool":"send_email","to":"user@example.com"}'),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("email");
    });

    it("detects email sending with alternate pattern", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry("email_send to user@example.com"),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("email");
    });

    it("detects blog post", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry("blog_post to medium about consciousness"),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("blog_post");
    });

    it("detects social media posting", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry("social_media post: hello world"),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("blog_post");
    });

    it("ignores non-tool_use entries even if they contain matching content", () => {
      const result = classifier.classifyFromLogEntries([
        textEntry("mcp__tinybus__send_message"),
      ]);
      expect(result).toBeNull();
    });

    it("returns first match when multiple external actions present", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry("mcp__tinybus__send_message"),
        toolEntry("send_email"),
      ]);
      expect(result).not.toBeNull();
      expect(result!.actionType).toBe("agora_send");
    });

    it("includes a description in the result", () => {
      const result = classifier.classifyFromLogEntries([
        toolEntry("mcp__tinybus__send_message"),
      ]);
      expect(result!.description).toBeTruthy();
    });
  });
});
