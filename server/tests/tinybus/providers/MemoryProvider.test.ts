import { MemoryProvider } from "../../../src/tinybus/providers/MemoryProvider";
import { createMessage } from "../../../src/tinybus/core/Message";

describe("MemoryProvider", () => {
  let provider: MemoryProvider;

  beforeEach(() => {
    provider = new MemoryProvider("test-provider");
  });

  describe("initialization", () => {
    it("has correct id", () => {
      expect(provider.id).toBe("test-provider");
    });

    it("is not ready before start", async () => {
      expect(await provider.isReady()).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("becomes ready after start", async () => {
      await provider.start();
      expect(await provider.isReady()).toBe(true);
    });

    it("becomes not ready after stop", async () => {
      await provider.start();
      await provider.stop();
      expect(await provider.isReady()).toBe(false);
    });
  });

  describe("send", () => {
    beforeEach(async () => {
      await provider.start();
    });

    it("stores sent messages", async () => {
      const message = createMessage({
        type: "test.message",
        payload: { data: "test" },
      });

      await provider.send(message);

      const sentMessages = provider.getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual(message);
    });

    it("stores multiple sent messages", async () => {
      const message1 = createMessage({ type: "test.1" });
      const message2 = createMessage({ type: "test.2" });

      await provider.send(message1);
      await provider.send(message2);

      const sentMessages = provider.getSentMessages();
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].type).toBe("test.1");
      expect(sentMessages[1].type).toBe("test.2");
    });

    it("throws error when not started", async () => {
      await provider.stop();

      const message = createMessage({ type: "test.message" });

      await expect(provider.send(message)).rejects.toThrow(
        "Provider test-provider not started"
      );
    });
  });

  describe("onMessage", () => {
    it("registers message handler", () => {
      const handler = jest.fn();
      provider.onMessage(handler);

      // Should not throw
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("injectMessage", () => {
    beforeEach(async () => {
      await provider.start();
    });

    it("calls message handler with injected message", async () => {
      const handler = jest.fn();
      provider.onMessage(handler);

      const message = createMessage({
        type: "test.inject",
        payload: { data: "test" },
      });

      await provider.injectMessage(message);

      expect(handler).toHaveBeenCalledWith(message);
    });

    it("stores received messages", async () => {
      provider.onMessage(async () => {});

      const message = createMessage({ type: "test.inject" });
      await provider.injectMessage(message);

      const receivedMessages = provider.getReceivedMessages();
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(message);
    });

    it("throws error when not started", async () => {
      await provider.stop();
      provider.onMessage(async () => {});

      const message = createMessage({ type: "test.message" });

      await expect(provider.injectMessage(message)).rejects.toThrow(
        "Provider test-provider not started"
      );
    });

    it("throws error when no handler registered", async () => {
      const message = createMessage({ type: "test.message" });

      await expect(provider.injectMessage(message)).rejects.toThrow(
        "No message handler registered for test-provider"
      );
    });
  });

  describe("clear", () => {
    beforeEach(async () => {
      await provider.start();
      provider.onMessage(async () => {});
    });

    it("clears sent messages", async () => {
      const message = createMessage({ type: "test.message" });
      await provider.send(message);

      provider.clear();

      expect(provider.getSentMessages()).toHaveLength(0);
    });

    it("clears received messages", async () => {
      const message = createMessage({ type: "test.message" });
      await provider.injectMessage(message);

      provider.clear();

      expect(provider.getReceivedMessages()).toHaveLength(0);
    });

    it("clears both sent and received messages", async () => {
      const message1 = createMessage({ type: "test.sent" });
      const message2 = createMessage({ type: "test.received" });

      await provider.send(message1);
      await provider.injectMessage(message2);

      provider.clear();

      expect(provider.getSentMessages()).toHaveLength(0);
      expect(provider.getReceivedMessages()).toHaveLength(0);
    });
  });

  describe("message history isolation", () => {
    beforeEach(async () => {
      await provider.start();
      provider.onMessage(async () => {});
    });

    it("returns copies of sent messages array", async () => {
      const message = createMessage({ type: "test.message" });
      await provider.send(message);

      const sentMessages1 = provider.getSentMessages();
      const sentMessages2 = provider.getSentMessages();

      expect(sentMessages1).not.toBe(sentMessages2);
      expect(sentMessages1).toEqual(sentMessages2);
    });

    it("returns copies of received messages array", async () => {
      const message = createMessage({ type: "test.message" });
      await provider.injectMessage(message);

      const receivedMessages1 = provider.getReceivedMessages();
      const receivedMessages2 = provider.getReceivedMessages();

      expect(receivedMessages1).not.toBe(receivedMessages2);
      expect(receivedMessages1).toEqual(receivedMessages2);
    });
  });

  describe("getMessageTypes", () => {
    it("returns empty array by default (accepts all message types)", () => {
      const defaultProvider = new MemoryProvider("default");
      expect(defaultProvider.getMessageTypes()).toEqual([]);
    });

    it("returns configured message types", () => {
      const types = ["agent.command.exec", "system.health.ping"];
      const typedProvider = new MemoryProvider("typed", types);
      expect(typedProvider.getMessageTypes()).toEqual(types);
    });

    it("returns a copy of the message types array", () => {
      const types = ["test.type"];
      const provider = new MemoryProvider("test", types);
      const types1 = provider.getMessageTypes();
      const types2 = provider.getMessageTypes();

      expect(types1).not.toBe(types2);
      expect(types1).toEqual(types2);
    });
  });

  describe("loopback mode", () => {
    beforeEach(async () => {
      await provider.start();
    });

    it("does not loopback by default", async () => {
      const handler = jest.fn();
      provider.onMessage(handler);

      const message = createMessage({ type: "test.message" });
      await provider.send(message);

      expect(handler).not.toHaveBeenCalled();
      expect(provider.getSentMessages()).toHaveLength(1);
    });

    it("loops back message when loopback is enabled", async () => {
      const loopbackProvider = new MemoryProvider("loopback", [], true);
      await loopbackProvider.start();

      const handler = jest.fn();
      loopbackProvider.onMessage(handler);

      const message = createMessage({ type: "test.message" });
      await loopbackProvider.send(message);

      expect(handler).toHaveBeenCalledTimes(1);
      const loopedMessage = handler.mock.calls[0][0];
      expect(loopedMessage.type).toBe("test.message");
      expect(loopedMessage.source).toBe("loopback");
      expect(loopbackProvider.getSentMessages()).toHaveLength(1);
      expect(loopbackProvider.getReceivedMessages()).toHaveLength(1);
    });

    it("does not loopback if handler is not registered", async () => {
      const loopbackProvider = new MemoryProvider("loopback", [], true);
      await loopbackProvider.start();

      const message = createMessage({ type: "test.message" });
      await loopbackProvider.send(message);

      expect(loopbackProvider.getSentMessages()).toHaveLength(1);
      expect(loopbackProvider.getReceivedMessages()).toHaveLength(0);
    });
  });
});
