import { SessionInjectionProvider } from "../../../src/tinybus/providers/SessionInjectionProvider";
import { createMessage } from "../../../src/tinybus/core/Message";

describe("SessionInjectionProvider", () => {
  let provider: SessionInjectionProvider;
  let injectFn: jest.Mock;

  beforeEach(() => {
    injectFn = jest.fn();
    provider = new SessionInjectionProvider("test-provider", injectFn);
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

    it("injects message into session", async () => {
      const message = createMessage({
        type: "test.message",
        payload: { data: "test" },
        source: "test-source",
      });

      await provider.send(message);

      expect(injectFn).toHaveBeenCalledTimes(1);
      const injectedText = injectFn.mock.calls[0][0];
      expect(typeof injectedText).toBe("string");
      const parsed = JSON.parse(injectedText);
      expect(parsed.type).toBe("test.message");
      expect(parsed.payload).toEqual({ data: "test" });
      expect(parsed.source).toBe("test-source");
    });

    it("throws error when not started", async () => {
      await provider.stop();

      const message = createMessage({ type: "test.message" });

      await expect(provider.send(message)).rejects.toThrow(
        "Provider test-provider not started"
      );
    });
  });

  describe("getMessageTypes", () => {
    it("returns empty array (accepts all message types)", () => {
      expect(provider.getMessageTypes()).toEqual([]);
    });
  });
});
