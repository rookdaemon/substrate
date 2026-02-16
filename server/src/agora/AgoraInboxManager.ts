import type { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { IClock } from "../substrate/abstractions/IClock";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileType } from "../substrate/types";
import { FileLock } from "../substrate/io/FileLock";
import type { Envelope } from "@rookdaemon/agora";
import { shortKey } from "./utils";

export interface AgoraInboxMessage {
  timestamp: string;
  sender: string;
  type: string;
  payload: unknown;
  envelopeId: string;
  read: boolean;
  repliedAt?: string;
}

/**
 * AgoraInboxManager manages the AGORA_INBOX.md file with structured read/write operations.
 * Messages move from Unread to Read sections as they are processed.
 */
export class AgoraInboxManager {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly clock: IClock
  ) {}

  /**
   * Add a new unread message to the inbox.
   */
  async addMessage(envelope: Envelope): Promise<void> {
    const release = await this.lock.acquire(SubstrateFileType.AGORA_INBOX);
    try {
      const filePath = this.config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await this.fs.readFile(filePath);
      
      const timestamp = this.clock.now().toISOString();
      const senderShort = shortKey(envelope.sender);
      const payloadStr = JSON.stringify(envelope.payload);
      
      // Parse current content
      const lines = content.split("\n");
      const unreadIndex = lines.findIndex(line => line.trim() === "## Unread");
      const readIndex = lines.findIndex(line => line.trim() === "## Read");
      
      if (unreadIndex === -1 || readIndex === -1) {
        throw new Error("Invalid AGORA_INBOX.md format: missing Unread or Read section");
      }
      
      // Insert the new message right after "## Unread" (newest first)
      const newMessage = `- [${timestamp}] id:${envelope.id} from:${senderShort} type:${envelope.type} payload:${payloadStr}`;
      
      // Find first empty line or next section after "## Unread"
      let insertIndex = unreadIndex + 1;
      // Skip the header line
      if (insertIndex < lines.length && lines[insertIndex].trim() === "") {
        insertIndex++;
      }
      
      lines.splice(insertIndex, 0, newMessage);
      
      await this.fs.writeFile(filePath, lines.join("\n"));
    } finally {
      release();
    }
  }

  /**
   * Get all unread messages from the inbox.
   */
  async getUnreadMessages(): Promise<AgoraInboxMessage[]> {
    const release = await this.lock.acquire(SubstrateFileType.AGORA_INBOX);
    try {
      const filePath = this.config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await this.fs.readFile(filePath);
      
      const lines = content.split("\n");
      const unreadIndex = lines.findIndex(line => line.trim() === "## Unread");
      const readIndex = lines.findIndex(line => line.trim() === "## Read");
      
      if (unreadIndex === -1 || readIndex === -1) {
        return [];
      }
      
      const messages: AgoraInboxMessage[] = [];
      for (let i = unreadIndex + 1; i < readIndex; i++) {
        const line = lines[i].trim();
        if (line.startsWith("- [")) {
          const parsed = this.parseMessageLine(line);
          if (parsed) {
            messages.push(parsed);
          }
        }
      }
      
      return messages;
    } finally {
      release();
    }
  }

  /**
   * Mark a message as read and optionally record reply timestamp.
   */
  async markAsRead(envelopeId: string, repliedAt?: string): Promise<void> {
    const release = await this.lock.acquire(SubstrateFileType.AGORA_INBOX);
    try {
      const filePath = this.config.getFilePath(SubstrateFileType.AGORA_INBOX);
      const content = await this.fs.readFile(filePath);
      
      const lines = content.split("\n");
      const unreadIndex = lines.findIndex(line => line.trim() === "## Unread");
      const readIndex = lines.findIndex(line => line.trim() === "## Read");
      
      if (unreadIndex === -1 || readIndex === -1) {
        throw new Error("Invalid AGORA_INBOX.md format: missing Unread or Read section");
      }
      
      // Find the message in Unread section
      let messageIndex = -1;
      let messageLine = "";
      for (let i = unreadIndex + 1; i < readIndex; i++) {
        const line = lines[i].trim();
        if (line.includes(`id:${envelopeId}`)) {
          messageIndex = i;
          messageLine = line;
          break;
        }
      }
      
      if (messageIndex === -1) {
        // Message not found in Unread section
        return;
      }
      
      // Remove from Unread section
      lines.splice(messageIndex, 1);
      
      // Add to Read section with reply metadata
      let readMessage = messageLine;
      if (repliedAt) {
        readMessage += ` → replied ${repliedAt}`;
      }
      
      // Find where to insert in Read section (right after "## Read")
      const readSectionStart = lines.findIndex((line, idx) => idx >= readIndex - 1 && line.trim() === "## Read");
      if (readSectionStart !== -1) {
        // Insert after "## Read" and empty line
        lines.splice(readSectionStart + 2, 0, readMessage);
      }
      
      await this.fs.writeFile(filePath, lines.join("\n"));
    } finally {
      release();
    }
  }

  private parseMessageLine(line: string): AgoraInboxMessage | null {
    // Format: - [timestamp] id:envelopeId from:sender type:type payload:payload
    const match = line.match(/^- \[([^\]]+)\] id:(\S+) from:(\S+) type:(\S+) payload:(.+)$/);
    if (!match) {
      return null;
    }
    
    const [, timestamp, envelopeId, sender, type, payloadStr] = match;
    let payload: unknown;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      payload = payloadStr;
    }
    
    return {
      timestamp,
      envelopeId,
      sender,
      type,
      payload,
      read: false,
    };
  }
}
