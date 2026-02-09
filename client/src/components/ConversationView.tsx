import { useState, useEffect } from "react";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";

interface SubstrateContent {
  rawMarkdown: string;
}

interface ConversationEntry {
  role: string;
  message: string;
}

interface ConversationViewProps {
  lastEvent: LoopEvent | null;
  refreshKey: number;
}

// Parse "[2025-01-01T10:00:00.000Z] [ROLE] message" into { role, message }
function parseLine(line: string): ConversationEntry | null {
  const match = line.match(/^\[.*?\]\s*\[(\w+)\]\s*(.*)$/);
  if (!match) return null;
  return { role: match[1], message: match[2] };
}

export function ConversationView({ lastEvent, refreshKey }: ConversationViewProps) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);

  const fetchConversation = () => {
    apiGet<SubstrateContent>("/api/substrate/CONVERSATION")
      .then((data) => {
        const parsed = data.rawMarkdown
          .split("\n")
          .filter((line) => line.startsWith("["))
          .map(parseLine)
          .filter((e): e is ConversationEntry => e !== null);
        setEntries(parsed);
      })
      .catch(() => {});
  };

  useEffect(() => { fetchConversation(); }, [refreshKey]);

  useEffect(() => {
    if (lastEvent?.type === "cycle_complete") {
      fetchConversation();
    }
  }, [lastEvent]);

  return (
    <div className="conversation-view">
      <h2>Conversation</h2>
      <div className="conversation-entries" data-testid="conversation-entries">
        {entries.length === 0 ? (
          <p>No conversation yet.</p>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="conversation-entry">
              <span className={`role-dot role-${entry.role.toLowerCase()}`} title={entry.role} />
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
