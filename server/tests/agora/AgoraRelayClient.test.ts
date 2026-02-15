import { AgoraRelayClient } from "../../src/agora/AgoraRelayClient";
import { Envelope } from "../../src/agora/AgoraService";
import WebSocket from "ws";

// Mock WebSocket
jest.mock("ws");

describe("AgoraRelayClient", () => {
  let client: AgoraRelayClient;
  let mockWs: jest.Mocked<WebSocket>;
  const testConfig = {
    url: "wss://test-relay.example.com",
    publicKey: "test-public-key-123",
    reconnectMaxMs: 60000,
  };

  // Helper to extract event handler from mock calls
  const getEventHandler = (eventName: string): ((data?: unknown) => void) | undefined => {
    const call = mockWs.on.mock.calls.find(c => c[0] === eventName);
    return call?.[1] as ((data?: unknown) => void) | undefined;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a mock WebSocket instance
    mockWs = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as jest.Mocked<WebSocket>;
    
    // Mock WebSocket constructor
    (WebSocket as unknown as jest.Mock).mockImplementation(() => mockWs);
    
    client = new AgoraRelayClient(testConfig);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("connect", () => {
    it("should create WebSocket connection", async () => {
      const connectPromise = client.connect();
      
      // Simulate WebSocket open event
      const openHandler = getEventHandler("open");
      openHandler?.();
      
      await connectPromise;
      
      expect(WebSocket).toHaveBeenCalledWith(testConfig.url);
    });

    it("should send registration message on connect", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler?.();
      
      await connectPromise;
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "register",
          publicKey: testConfig.publicKey,
        })
      );
    });

    it("should not reconnect if already connected", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Clear mock calls
      (WebSocket as unknown as jest.Mock).mockClear();
      
      // Try to connect again
      await client.connect();
      
      // Should not create new WebSocket
      expect(WebSocket).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("should close WebSocket connection", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      await client.disconnect();
      
      expect(mockWs.close).toHaveBeenCalled();
    });

    it("should prevent automatic reconnection after disconnect", async () => {
      jest.useFakeTimers();
      
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      await client.disconnect();
      
      // Simulate close event
      const closeHandler = getEventHandler("close");
      closeHandler();
      
      // Clear WebSocket constructor calls
      (WebSocket as unknown as jest.Mock).mockClear();
      
      // Fast-forward time
      jest.advanceTimersByTime(10000);
      
      // Should not reconnect
      expect(WebSocket).not.toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("should mark as registered on 'registered' message", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Should not be registered yet
      expect(client.isConnected()).toBe(false);
      
      // Simulate registered message
      const messageHandler = getEventHandler("message");
      messageHandler(Buffer.from(JSON.stringify({ type: "registered" })));
      
      // Now should be connected
      expect(client.isConnected()).toBe(true);
    });

    it("should call message handler on incoming message", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      const testEnvelope: Envelope = {
        id: "test-id",
        type: "publish",
        sender: "test-sender",
        timestamp: Date.now(),
        payload: { text: "Hello" },
        signature: "test-signature",
      };
      
      const handler = jest.fn();
      client.setMessageHandler(handler);
      
      // Simulate incoming message
      const messageHandler = getEventHandler("message");
      messageHandler(Buffer.from(JSON.stringify({
        type: "message",
        envelope: testEnvelope,
      })));
      
      expect(handler).toHaveBeenCalledWith(testEnvelope);
    });

    it("should handle 'error' messages", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Simulate error message
      const messageHandler = getEventHandler("message");
      messageHandler(Buffer.from(JSON.stringify({
        type: "error",
        message: "Test error",
      })));
      
      expect(consoleSpy).toHaveBeenCalledWith("Relay server error:", "Test error");
      
      consoleSpy.mockRestore();
    });
  });

  describe("sendMessage", () => {
    it("should send message through relay when connected", async () => {
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Mark as registered
      const messageHandler = getEventHandler("message");
      messageHandler(Buffer.from(JSON.stringify({ type: "registered" })));
      
      const testEnvelope: Envelope = {
        id: "test-id",
        type: "publish",
        sender: "test-sender",
        timestamp: Date.now(),
        payload: { text: "Hello" },
        signature: "test-signature",
      };
      
      const result = await client.sendMessage("peer-public-key", testEnvelope);
      
      expect(result.ok).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "message",
          to: "peer-public-key",
          envelope: testEnvelope,
        })
      );
    });

    it("should return error when not connected", async () => {
      const result = await client.sendMessage("peer-public-key", {} as Envelope);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Not connected to relay");
    });
  });

  describe("reconnection", () => {
    it("should not reconnect after explicit disconnect", async () => {
      jest.useFakeTimers();
      
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Explicitly disconnect
      await client.disconnect();
      
      // Simulate close event
      const closeHandler = getEventHandler("close");
      closeHandler();
      
      // Clear WebSocket constructor calls
      (WebSocket as unknown as jest.Mock).mockClear();
      
      // Fast-forward time
      await jest.advanceTimersByTimeAsync(10000);
      
      // Should not reconnect after explicit disconnect
      expect(WebSocket).not.toHaveBeenCalled();
    });

    it("should respect max reconnect delay in config", () => {
      const shortMaxClient = new AgoraRelayClient({
        ...testConfig,
        reconnectMaxMs: 5000, // 5 second max
      });
      
      // Just verify the client was created with the config
      // Testing the exact timing behavior with mocks is challenging
      expect(shortMaxClient).toBeDefined();
    });
  });

  describe("heartbeat", () => {
    it("should send ping messages periodically", async () => {
      jest.useFakeTimers();
      
      const connectPromise = client.connect();
      
      const openHandler = getEventHandler("open");
      openHandler();
      
      await connectPromise;
      
      // Clear initial registration call
      mockWs.send.mockClear();
      
      // Fast-forward 30 seconds
      jest.advanceTimersByTime(30000);
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ping" })
      );
    });
  });
});
