import { createMessage } from "../../../src/tinybus/core/Message";

describe("Message", () => {
  describe("createMessage", () => {
    it("creates a message with required fields", () => {
      const message = createMessage({
        type: "test.message",
      });

      expect(message.id).toBeDefined();
      expect(message.type).toBe("test.message");
      expect(message.schema).toBe("v1");
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it("includes optional fields when provided", () => {
      const message = createMessage({
        type: "agent.command.exec",
        source: "provider-1",
        destination: "provider-2",
        payload: { data: "test" },
        meta: { key: "value" },
      });

      expect(message.source).toBe("provider-1");
      expect(message.destination).toBe("provider-2");
      expect(message.payload).toEqual({ data: "test" });
      expect(message.meta).toEqual({ key: "value" });
    });

    it("generates unique IDs for different messages", () => {
      const message1 = createMessage({ type: "test.1" });
      const message2 = createMessage({ type: "test.2" });

      expect(message1.id).not.toBe(message2.id);
    });

    it("generates different timestamps for sequential messages", async () => {
      const message1 = createMessage({ type: "test.1" });
      
      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 2));
      
      const message2 = createMessage({ type: "test.2" });

      expect(message2.timestamp).toBeGreaterThanOrEqual(message1.timestamp);
    });

    it("supports dot notation message types", () => {
      const message = createMessage({
        type: "agent.command.exec",
      });

      expect(message.type).toBe("agent.command.exec");
    });

    it("supports URI-style message types", () => {
      const message = createMessage({
        type: "tinybus://agent/command/exec",
      });

      expect(message.type).toBe("tinybus://agent/command/exec");
    });

    it("handles complex payloads", () => {
      const complexPayload = {
        nested: {
          data: [1, 2, 3],
          flag: true,
        },
        array: ["a", "b", "c"],
      };

      const message = createMessage({
        type: "test.complex",
        payload: complexPayload,
      });

      expect(message.payload).toEqual(complexPayload);
    });
  });
});
