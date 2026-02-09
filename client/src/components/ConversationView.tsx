import { useState, useEffect } from "react";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";

interface SubstrateContent {
  rawMarkdown: string;
}

interface ConversationViewProps {
  lastEvent: LoopEvent | null;
  refreshKey: number;
}

export function ConversationView({ lastEvent, refreshKey }: ConversationViewProps) {
  const [entries, setEntries] = useState<string[]>([]);

  const fetchConversation = () => {
    apiGet<SubstrateContent>("/api/substrate/CONVERSATION")
      .then((data) => {
        const lines = data.rawMarkdown
          .split("\n")
          .filter((line) => line.startsWith("["));
        setEntries(lines);
      })
      .catch(() => {});
  };

  useEffect(() => { fetchConversation(); }, [refreshKey]);

  useEffect(() => {
    if (lastEvent?.type === "cycle_complete") {
      fetchConversation();
    }
    if (lastEvent?.type === "process_output") {
      const { role, entry } = lastEvent.data as {
        role: string;
        entry: { type: string; content: string };
      };
      if (entry.type === "text") {
        const line = `[${lastEvent.timestamp}] [${role}] ${entry.content}`;
        setEntries((prev) => [...prev, line]);
      }
    }
  }, [lastEvent]);

  return (
    <div className="conversation-view">
      <h2>Conversation</h2>
      <div className="conversation-entries" data-testid="conversation-entries">
        {entries.length === 0 ? (
          <p>No conversation yet.</p>
        ) : (
          entries.map((entry, i) => <div key={i} className="conversation-entry">{entry}</div>)
        )}
      </div>
    </div>
  );
}
