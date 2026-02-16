import { AgoraInboxManager } from "../../src/agora/AgoraInboxManager";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { SubstrateFileType } from "../../src/substrate/types";
import type { Envelope } from "@rookdaemon/agora";

describe("AgoraInboxManager", () => {
  let manager: AgoraInboxManager;
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let lock: FileLock;

  const initialContent = `# Agora Inbox

Messages received from other agents via the Agora protocol. Messages move from Unread to Read after processing.

## Unread

No unread messages.

## Read

No read messages yet.
`;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-15T12:00:00Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();

    // Initialize AGORA_INBOX.md
    const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
    await fs.writeFile(inboxPath, initialContent);

    manager = new AgoraInboxManager(fs, config, lock, clock);
  });

  describe("addMessage", () => {
    it("should add a new unread message to the inbox", async () => {
      const envelope: Envelope = {
        id: "msg-123",
        type: "request",
        sender: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        timestamp: 1708000000000,
        payload: { question: "Hello, are you there?" },
        signature: "test-signature",
      };

      await manager.addMessage(envelope);

      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await fs.readFile(inboxPath);

      expect(content).toContain("## Unread");
      expect(content).toContain("id:msg-123");
      expect(content).toContain("from:cdefabcd...");
      expect(content).toContain("type:request");
      expect(content).toContain('"question":"Hello, are you there?"');
    });

    it("should add multiple messages in order", async () => {
      const envelope1: Envelope = {
        id: "msg-1",
        type: "announce",
        sender: "pubkey1",
        timestamp: 1708000000000,
        payload: { data: "first" },
        signature: "sig1",
      };

      const envelope2: Envelope = {
        id: "msg-2",
        type: "request",
        sender: "pubkey2",
        timestamp: 1708000001000,
        payload: { data: "second" },
        signature: "sig2",
      };

      await manager.addMessage(envelope1);
      clock.setNow(new Date("2026-02-15T12:01:00Z"));
      await manager.addMessage(envelope2);

      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await fs.readFile(inboxPath);

      // Both messages should be present
      expect(content).toContain("id:msg-1");
      expect(content).toContain("id:msg-2");
      
      // Second message should appear before first (newer messages at top)
      const msg1Index = content.indexOf("id:msg-1");
      const msg2Index = content.indexOf("id:msg-2");
      expect(msg2Index).toBeLessThan(msg1Index);
    });
  });

  describe("getUnreadMessages", () => {
    it("should return empty array when no unread messages", async () => {
      const messages = await manager.getUnreadMessages();
      expect(messages).toEqual([]);
    });

    it("should return all unread messages", async () => {
      const envelope1: Envelope = {
        id: "msg-1",
        type: "announce",
        sender: "pubkey1",
        timestamp: 1708000000000,
        payload: { data: "first" },
        signature: "sig1",
      };

      const envelope2: Envelope = {
        id: "msg-2",
        type: "request",
        sender: "pubkey2",
        timestamp: 1708000001000,
        payload: { data: "second" },
        signature: "sig2",
      };

      await manager.addMessage(envelope1);
      await manager.addMessage(envelope2);

      const messages = await manager.getUnreadMessages();

      expect(messages).toHaveLength(2);
      expect(messages[0].envelopeId).toBe("msg-2"); // Newer first
      expect(messages[1].envelopeId).toBe("msg-1");
      expect(messages[0].read).toBe(false);
      expect(messages[1].read).toBe(false);
    });

    it("should parse message payload correctly", async () => {
      const envelope: Envelope = {
        id: "msg-123",
        type: "request",
        sender: "pubkey",
        timestamp: 1708000000000,
        payload: { question: "Hello?", priority: 1 },
        signature: "sig",
      };

      await manager.addMessage(envelope);
      const messages = await manager.getUnreadMessages();

      expect(messages).toHaveLength(1);
      expect(messages[0].payload).toEqual({ question: "Hello?", priority: 1 });
    });
  });

  describe("markAsRead", () => {
    it("should move message from Unread to Read section", async () => {
      const envelope: Envelope = {
        id: "msg-123",
        type: "request",
        sender: "pubkey",
        timestamp: 1708000000000,
        payload: { data: "test" },
        signature: "sig",
      };

      await manager.addMessage(envelope);
      await manager.markAsRead("msg-123");

      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await fs.readFile(inboxPath);

      // Message should no longer be in Unread section
      const lines = content.split("\n");
      const unreadIndex = lines.findIndex(l => l.trim() === "## Unread");
      const readIndex = lines.findIndex(l => l.trim() === "## Read");

      const unreadSection = lines.slice(unreadIndex, readIndex).join("\n");
      const readSection = lines.slice(readIndex).join("\n");

      expect(unreadSection).not.toContain("id:msg-123");
      expect(readSection).toContain("id:msg-123");
    });

    it("should add reply timestamp when provided", async () => {
      const envelope: Envelope = {
        id: "msg-456",
        type: "request",
        sender: "pubkey",
        timestamp: 1708000000000,
        payload: { data: "test" },
        signature: "sig",
      };

      await manager.addMessage(envelope);
      await manager.markAsRead("msg-456", "2026-02-15T12:05:00Z");

      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await fs.readFile(inboxPath);

      expect(content).toContain("id:msg-456");
      expect(content).toContain("→ replied 2026-02-15T12:05:00Z");
    });

    it("should do nothing if message not found", async () => {
      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const beforeContent = await fs.readFile(inboxPath);

      await manager.markAsRead("non-existent-id");

      const afterContent = await fs.readFile(inboxPath);
      expect(afterContent).toBe(beforeContent);
    });

    it("should handle multiple messages being marked as read", async () => {
      const envelope1: Envelope = {
        id: "msg-1",
        type: "announce",
        sender: "pubkey1",
        timestamp: 1708000000000,
        payload: { data: "first" },
        signature: "sig1",
      };

      const envelope2: Envelope = {
        id: "msg-2",
        type: "request",
        sender: "pubkey2",
        timestamp: 1708000001000,
        payload: { data: "second" },
        signature: "sig2",
      };

      await manager.addMessage(envelope1);
      await manager.addMessage(envelope2);

      // Mark first as read
      await manager.markAsRead("msg-1", "2026-02-15T12:01:00Z");

      // Second should still be unread
      const messages = await manager.getUnreadMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].envelopeId).toBe("msg-2");

      // Mark second as read
      await manager.markAsRead("msg-2", "2026-02-15T12:02:00Z");

      // No unread messages
      const messagesAfter = await manager.getUnreadMessages();
      expect(messagesAfter).toHaveLength(0);

      // Both in read section
      const inboxPath = config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await fs.readFile(inboxPath);
      const lines = content.split("\n");
      const readIndex = lines.findIndex(l => l.trim() === "## Read");
      const readSection = lines.slice(readIndex).join("\n");

      expect(readSection).toContain("id:msg-1");
      expect(readSection).toContain("id:msg-2");
    });
  });
});
