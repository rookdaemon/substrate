import { TinyBus } from "../../../src/tinybus/core/TinyBus";
import { createMessage } from "../../../src/tinybus/core/Message";
import { MemoryProvider } from "../../../src/tinybus/providers/MemoryProvider";

describe("TinyBus", () => {
  let tinyBus: TinyBus;
  let provider1: MemoryProvider;
  let provider2: MemoryProvider;

  beforeEach(() => {
    tinyBus = new TinyBus();
    provider1 = new MemoryProvider("provider-1");
    provider2 = new MemoryProvider("provider-2");
  });

  describe("provider registration", () => {
    it("registers a provider successfully", () => {
      tinyBus.registerProvider(provider1);

      const providers = tinyBus.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe("provider-1");
    });

    it("registers multiple providers", () => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);

      const providers = tinyBus.getProviders();
      expect(providers).toHaveLength(2);
    });

    it("throws error when registering duplicate provider id", () => {
      tinyBus.registerProvider(provider1);

      expect(() => {
        tinyBus.registerProvider(provider1);
      }).toThrow("Provider provider-1 already registered");
    });
  });

  describe("lifecycle", () => {
    beforeEach(() => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
    });

    it("starts all providers", async () => {
      await tinyBus.start();

      expect(await provider1.isReady()).toBe(true);
      expect(await provider2.isReady()).toBe(true);
      expect(tinyBus.isStarted()).toBe(true);
    });

    it("emits started event", async () => {
      const listener = jest.fn();
      tinyBus.on("tinybus.started", listener);

      await tinyBus.start();

      expect(listener).toHaveBeenCalledWith({});
    });

    it("stops all providers", async () => {
      await tinyBus.start();
      await tinyBus.stop();

      expect(await provider1.isReady()).toBe(false);
      expect(await provider2.isReady()).toBe(false);
      expect(tinyBus.isStarted()).toBe(false);
    });

    it("emits stopped event", async () => {
      const listener = jest.fn();
      tinyBus.on("tinybus.stopped", listener);

      await tinyBus.start();
      await tinyBus.stop();

      expect(listener).toHaveBeenCalledWith({});
    });

    it("handles multiple start calls gracefully", async () => {
      await tinyBus.start();
      await tinyBus.start();

      expect(tinyBus.isStarted()).toBe(true);
    });

    it("handles multiple stop calls gracefully", async () => {
      await tinyBus.start();
      await tinyBus.stop();
      await tinyBus.stop();

      expect(tinyBus.isStarted()).toBe(false);
    });

    it("throws error when publishing before start", async () => {
      const message = createMessage({ type: "test.message" });

      await expect(tinyBus.publish(message)).rejects.toThrow(
        "TinyBus not started"
      );
    });
  });

  describe("direct routing", () => {
    beforeEach(async () => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
      await tinyBus.start();
    });

    afterEach(async () => {
      await tinyBus.stop();
    });

    it("routes message to specific destination", async () => {
      const message = createMessage({
        type: "test.message",
        source: "provider-1",
        destination: "provider-2",
        payload: { data: "test" },
      });

      await tinyBus.publish(message);

      const sentMessages = provider2.getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe("test.message");
      expect(sentMessages[0].payload).toEqual({ data: "test" });

      // Source provider should not receive
      expect(provider1.getSentMessages()).toHaveLength(0);
    });

    it("emits routed event for successful routing", async () => {
      const listener = jest.fn();
      tinyBus.on("message.routed", listener);

      const message = createMessage({
        type: "test.message",
        destination: "provider-2",
      });

      await tinyBus.publish(message);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          message,
          provider: "provider-2",
        })
      );
    });

    it("emits dropped event when destination not found", async () => {
      const listener = jest.fn();
      tinyBus.on("message.dropped", listener);

      const message = createMessage({
        type: "test.message",
        destination: "non-existent",
      });

      await tinyBus.publish(message);

      expect(listener).toHaveBeenCalledWith({
        message,
        reason: "No target providers",
      });
    });
  });

  describe("broadcast routing", () => {
    let provider3: MemoryProvider;

    beforeEach(async () => {
      provider3 = new MemoryProvider("provider-3");
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
      tinyBus.registerProvider(provider3);
      await tinyBus.start();
    });

    afterEach(async () => {
      await tinyBus.stop();
    });

    it("broadcasts to all providers except source", async () => {
      const message = createMessage({
        type: "test.broadcast",
        source: "provider-1",
        payload: { broadcast: true },
      });

      await tinyBus.publish(message);

      // Source provider should not receive
      expect(provider1.getSentMessages()).toHaveLength(0);

      // Other providers should receive
      expect(provider2.getSentMessages()).toHaveLength(1);
      expect(provider3.getSentMessages()).toHaveLength(1);

      expect(provider2.getSentMessages()[0].type).toBe("test.broadcast");
      expect(provider3.getSentMessages()[0].type).toBe("test.broadcast");
    });

    it("broadcasts to all providers when no source", async () => {
      const message = createMessage({
        type: "test.broadcast",
        payload: { broadcast: true },
      });

      await tinyBus.publish(message);

      // All providers should receive
      expect(provider1.getSentMessages()).toHaveLength(1);
      expect(provider2.getSentMessages()).toHaveLength(1);
      expect(provider3.getSentMessages()).toHaveLength(1);
    });
  });

  describe("inbound message handling", () => {
    beforeEach(async () => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
      await tinyBus.start();
    });

    afterEach(async () => {
      await tinyBus.stop();
    });

    it("routes inbound messages through the bus", async () => {
      const message = createMessage({
        type: "inbound.test",
        source: "provider-1",
        destination: "provider-2",
      });

      await provider1.injectMessage(message);

      // Message should be routed to provider-2
      expect(provider2.getSentMessages()).toHaveLength(1);
      expect(provider2.getSentMessages()[0].type).toBe("inbound.test");
    });

    it("emits inbound event", async () => {
      const listener = jest.fn();
      tinyBus.on("message.inbound", listener);

      const message = createMessage({
        type: "inbound.test",
        source: "provider-1",
      });

      await provider1.injectMessage(message);

      expect(listener).toHaveBeenCalledWith({ message });
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
      await tinyBus.start();
    });

    afterEach(async () => {
      await tinyBus.stop();
    });

    it("emits error event when provider send fails", async () => {
      const errorListener = jest.fn();
      tinyBus.on("message.error", errorListener);

      // Stop provider to cause send to fail
      await provider2.stop();

      const message = createMessage({
        type: "test.message",
        destination: "provider-2",
      });

      await tinyBus.publish(message);

      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({
          message,
          provider: "provider-2",
          error: expect.any(String),
        })
      );
    });

    it("continues processing after provider error", async () => {
      // Stop provider-2 to cause error
      await provider2.stop();

      const message = createMessage({
        type: "test.broadcast",
        source: "provider-1",
      });

      // Should not throw
      await tinyBus.publish(message);
    });

    it("ignores listener errors silently", async () => {
      const errorListener = jest.fn(() => {
        throw new Error("Listener error");
      });
      tinyBus.on("message.outbound", errorListener);

      const message = createMessage({
        type: "test.message",
        destination: "provider-2",
      });

      // Should not throw
      await expect(tinyBus.publish(message)).resolves.not.toThrow();
    });
  });

  describe("event system", () => {
    it("registers and removes event listeners", () => {
      const listener = jest.fn();

      tinyBus.on("message.outbound", listener);
      tinyBus.off("message.outbound", listener);

      // Listener should not be called after removal
      tinyBus.emit("message.outbound", {});
      expect(listener).not.toHaveBeenCalled();
    });

    it("supports multiple listeners for same event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      tinyBus.on("message.outbound", listener1);
      tinyBus.on("message.outbound", listener2);

      tinyBus.emit("message.outbound", {});

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  describe("message flow", () => {
    beforeEach(async () => {
      tinyBus.registerProvider(provider1);
      tinyBus.registerProvider(provider2);
      await tinyBus.start();
    });

    afterEach(async () => {
      await tinyBus.stop();
    });

    it("tracks complete message flow with all events", async () => {
      const events: string[] = [];

      tinyBus.on("message.outbound", () => events.push("outbound"));
      tinyBus.on("message.routed", () => events.push("routed"));
      tinyBus.on("message.inbound", () => events.push("inbound"));

      const message = createMessage({
        type: "test.flow",
        source: "provider-1",
        destination: "provider-2",
      });

      await provider1.injectMessage(message);

      expect(events).toEqual(["inbound", "outbound", "routed"]);
    });
  });

  describe("observability (#223)", () => {
    it("logs lifecycle events when logger is provided", async () => {
      const logEntries: string[] = [];
      const logger = {
        debug: (msg: string) => logEntries.push(msg),
        warn: (msg: string) => logEntries.push(`WARN: ${msg}`),
        error: (msg: string) => logEntries.push(`ERROR: ${msg}`),
        verbose: (msg: string) => logEntries.push(`VERBOSE: ${msg}`),
      };
      const bus = new TinyBus(undefined, logger);
      bus.registerProvider(new MemoryProvider("p1"));

      await bus.start();
      await bus.stop();

      expect(logEntries.some(e => e.includes("[TINYBUS] Starting with 1 providers"))).toBe(true);
      expect(logEntries.some(e => e.includes("[TINYBUS] Started successfully"))).toBe(true);
      expect(logEntries.some(e => e.includes("[TINYBUS] Stopping"))).toBe(true);
      expect(logEntries.some(e => e.includes("[TINYBUS] Stopped"))).toBe(true);
    });

    it("logs routed messages with timing", async () => {
      const logEntries: string[] = [];
      const logger = {
        debug: (msg: string) => logEntries.push(msg),
        warn: () => {},
        error: () => {},
        verbose: () => {},
      };
      const bus = new TinyBus(undefined, logger);
      const p1 = new MemoryProvider("p1");
      const p2 = new MemoryProvider("p2");
      bus.registerProvider(p1);
      bus.registerProvider(p2);
      await bus.start();

      const message = createMessage({
        type: "test.observe",
        source: "p1",
        destination: "p2",
      });
      await bus.publish(message);

      const routedLog = logEntries.find(e => e.includes("[TINYBUS] Routed:") && e.includes("test.observe"));
      expect(routedLog).toBeDefined();
      expect(routedLog).toContain("provider=p2");
      expect(routedLog).toContain("durationMs=");

      await bus.stop();
    });

    it("logs dropped messages", async () => {
      const logEntries: string[] = [];
      const logger = {
        debug: (msg: string) => logEntries.push(msg),
        warn: () => {},
        error: () => {},
        verbose: () => {},
      };
      const bus = new TinyBus(undefined, logger);
      const p1 = new MemoryProvider("p1");
      bus.registerProvider(p1);
      await bus.start();

      const message = createMessage({
        type: "test.drop",
        destination: "nonexistent",
      });
      await bus.publish(message);

      const droppedLog = logEntries.find(e => e.includes("[TINYBUS] Dropped:") && e.includes("test.drop"));
      expect(droppedLog).toBeDefined();
      expect(droppedLog).toContain("reason=no_target_providers");

      await bus.stop();
    });

    it("warns on provider errors with timing", async () => {
      const warnEntries: string[] = [];
      const logger = {
        debug: () => {},
        warn: (msg: string) => warnEntries.push(msg),
        error: () => {},
        verbose: () => {},
      };
      const bus = new TinyBus(undefined, logger);
      const p1 = new MemoryProvider("p1");
      const p2 = new MemoryProvider("p2");
      bus.registerProvider(p1);
      bus.registerProvider(p2);
      await bus.start();

      // Stop p2 to cause send failure
      await p2.stop();

      const message = createMessage({
        type: "test.error",
        destination: "p2",
      });
      await bus.publish(message);

      const errorLog = warnEntries.find(e => e.includes("[TINYBUS] Error:") && e.includes("test.error"));
      expect(errorLog).toBeDefined();
      expect(errorLog).toContain("provider=p2");
      expect(errorLog).toContain("durationMs=");

      await bus.stop();
    });

    it("emits message.complete event with routing summary", async () => {
      const bus = new TinyBus();
      const p1 = new MemoryProvider("p1");
      const p2 = new MemoryProvider("p2");
      const p3 = new MemoryProvider("p3");
      bus.registerProvider(p1);
      bus.registerProvider(p2);
      bus.registerProvider(p3);
      await bus.start();

      const completeListener = jest.fn();
      bus.on("message.complete", completeListener);

      const message = createMessage({
        type: "test.complete",
        source: "p1",
      });
      await bus.publish(message);

      expect(completeListener).toHaveBeenCalledWith(
        expect.objectContaining({
          message,
          routedTo: 2, // p2 and p3 (not p1 — source excluded)
          successCount: 2,
          errorCount: 0,
          durationMs: expect.any(Number),
        })
      );

      await bus.stop();
    });

    it("message.complete reports errors correctly", async () => {
      const bus = new TinyBus();
      const p1 = new MemoryProvider("p1");
      const p2 = new MemoryProvider("p2");
      bus.registerProvider(p1);
      bus.registerProvider(p2);
      await bus.start();

      // Stop p2 to cause error
      await p2.stop();

      const completeListener = jest.fn();
      bus.on("message.complete", completeListener);

      const message = createMessage({
        type: "test.complete.error",
        source: "p1",
      });
      await bus.publish(message);

      expect(completeListener).toHaveBeenCalledWith(
        expect.objectContaining({
          routedTo: 1, // only p2 (p1 excluded as source)
          successCount: 0,
          errorCount: 1,
        })
      );

      await bus.stop();
    });

    it("works without logger (backward compatible)", async () => {
      const bus = new TinyBus(); // no logger
      const p1 = new MemoryProvider("p1");
      bus.registerProvider(p1);
      await bus.start();

      const message = createMessage({ type: "test.nolog" });
      await expect(bus.publish(message)).resolves.not.toThrow();

      await bus.stop();
    });

    it("routed event includes durationMs", async () => {
      const bus = new TinyBus();
      const p1 = new MemoryProvider("p1");
      bus.registerProvider(p1);
      await bus.start();

      const routedListener = jest.fn();
      bus.on("message.routed", routedListener);

      const message = createMessage({ type: "test.timing" });
      await bus.publish(message);

      expect(routedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "p1",
          durationMs: expect.any(Number),
        })
      );

      await bus.stop();
    });

    it("logs inbound messages", async () => {
      const logEntries: string[] = [];
      const logger = {
        debug: (msg: string) => logEntries.push(msg),
        warn: () => {},
        error: () => {},
        verbose: () => {},
      };
      const bus = new TinyBus(undefined, logger);
      const p1 = new MemoryProvider("p1");
      const p2 = new MemoryProvider("p2");
      bus.registerProvider(p1);
      bus.registerProvider(p2);
      await bus.start();

      const message = createMessage({
        type: "test.inbound",
        source: "p1",
        destination: "p2",
      });
      await p1.injectMessage(message);

      const inboundLog = logEntries.find(e => e.includes("[TINYBUS] Inbound:") && e.includes("test.inbound"));
      expect(inboundLog).toBeDefined();
      expect(inboundLog).toContain("source=p1");

      await bus.stop();
    });
  });
});
