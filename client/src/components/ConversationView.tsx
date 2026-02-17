import { useState, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";

interface SubstrateContent {
  rawMarkdown: string;
}

interface ConversationEntry {
  role: string;
  message: string;
  provider?: "agora" | "tinybus";
  senderName?: string;
}

interface ConversationViewProps {
  lastEvent: LoopEvent | null;
  refreshKey: number;
}

const ENTRY_RE = /^\[[\d\-T:.Z]+\]\s*\[(\w+)\]\s*/;

function parseEntries(raw: string): ConversationEntry[] {
  const lines = raw.split("\n");
  const entries: ConversationEntry[] = [];
  let current: ConversationEntry | null = null;

  for (const line of lines) {
    const match = line.match(ENTRY_RE);
    if (match) {
      if (current) entries.push(current);
      const message = line.replace(ENTRY_RE, "");
      
      // Detect provider type and extract sender name
      // Agora messages: **senderShort** (type) - sender keys are short (start with ... or are 12-20 chars)
      // TinyBus messages: **source** (type) - source names are typically longer/internal
      let provider: "agora" | "tinybus" | undefined;
      let senderName: string | undefined;
      
      // Check for old format first (for backwards compatibility)
      if (message.includes("📨") || message.includes("Agora message")) {
        provider = "agora";
        // Extract sender from old format if possible
        const oldAgoraMatch = message.match(/from [`']?([^`'\s]+)/);
        if (oldAgoraMatch) senderName = oldAgoraMatch[1];
      } else if (message.includes("🔔") || message.includes("TinyBus message")) {
        provider = "tinybus";
        // Extract source from old format if possible
        const oldTinyBusMatch = message.match(/from [`']?([^`'\s]+)/);
        if (oldTinyBusMatch) senderName = oldTinyBusMatch[1];
      } else {
        // New format: **senderName** (type) or **senderName** [UNPROCESSED] payload (one line)
        const boldMatch = message.match(/^\*\*([^*]+)\*\*(?:\s*\([^)]+\))?/);
        if (boldMatch) {
          senderName = boldMatch[1];
          // Detection heuristic:
          // - Agora: short keys (start with "..." or are 8-20 chars, alphanumeric/hex-like)
          // - TinyBus: longer names, might contain dots/dashes, or common source names
          const isShortKey = senderName.startsWith("...") || 
                            (senderName.length >= 8 && senderName.length <= 20 && /^[a-f0-9.]+$/i.test(senderName));
          const isInternalSource = senderName.includes(".") || 
                                  senderName.includes("-") ||
                                  senderName.length > 20 ||
                                  /^(file|http|process|system|loop|orchestrator)/i.test(senderName);
          
          if (isShortKey && !isInternalSource) {
            provider = "agora";
          } else if (isInternalSource || match[1] === "SUBCONSCIOUS") {
            // If it's from SUBCONSCIOUS role and doesn't look like agora, it's likely tinybus
            // match[1] is the role from the timestamp line
            provider = "tinybus";
          }
        }
      }
      
      current = { 
        role: match[1], 
        message,
        provider,
        senderName,
      };
    } else if (current) {
      current.message += "\n" + line;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function ConversationView({ lastEvent, refreshKey }: ConversationViewProps) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const entriesRef = useRef<HTMLDivElement>(null);

  const fetchConversation = () => {
    apiGet<SubstrateContent>("/api/substrate/CONVERSATION")
      .then((data) => {
        setEntries(parseEntries(data.rawMarkdown));
      })
      .catch(() => {});
  };

  useEffect(() => { fetchConversation(); }, [refreshKey]);

  useEffect(() => {
    if (lastEvent?.type === "cycle_complete" || 
        lastEvent?.type === "conversation_response" ||
        (lastEvent?.type === "file_changed" && lastEvent.data.fileType === "CONVERSATION")) {
      fetchConversation();
    }
  }, [lastEvent]);

  useEffect(() => {
    const el = entriesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="conversation-view">
      <div className="conversation-entries" data-testid="conversation-entries" ref={entriesRef}>
        {entries.length === 0 ? (
          <p>No conversation yet.</p>
        ) : (
          entries.map((entry, i) => (
            <div 
              key={i} 
              className={`conversation-entry ${entry.provider === "agora" ? "agora-message" : ""} ${entry.provider === "tinybus" ? "tinybus-message" : ""}`}
            >
              <span className={`role-dot role-${entry.role.toLowerCase()}`} title={entry.role} />
              <div className="conversation-message">
                <Markdown>{entry.message}</Markdown>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
