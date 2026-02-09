import { useState, useEffect, useRef } from "react";
import { LoopEvent } from "../hooks/useWebSocket";

const AGENT_COLORS: Record<string, string> = {
  EGO: "#00d4ff",
  SUBCONSCIOUS: "#4caf50",
  SUPEREGO: "#ffd700",
  ID: "#e040fb",
};

interface ProcessEntry {
  role: string;
  cycleNumber: number;
  type: string;
  content: string;
  timestamp: string;
}

interface ProcessLogProps {
  lastEvent: LoopEvent | null;
}

export function ProcessLog({ lastEvent }: ProcessLogProps) {
  const [entries, setEntries] = useState<ProcessEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastEvent?.type !== "process_output") return;
    const { role, cycleNumber, entry } = lastEvent.data as {
      role: string;
      cycleNumber: number;
      entry: { type: string; content: string };
    };
    setEntries((prev) => [
      ...prev,
      {
        role,
        cycleNumber,
        type: entry.type,
        content: entry.content,
        timestamp: lastEvent.timestamp,
      },
    ]);
  }, [lastEvent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const handleClear = () => setEntries([]);

  return (
    <div className="process-log">
      <div className="process-log-header">
        <h2>Process Log</h2>
        <button className="process-log-clear" onClick={handleClear}>Clear</button>
      </div>
      <div className="process-log-entries" data-testid="process-log-entries">
        {entries.length === 0 ? (
          <p>No process output yet.</p>
        ) : (
          entries.map((entry, i) => {
            const color = AGENT_COLORS[entry.role] ?? "#888";
            return (
              <div key={i} className="process-log-entry">
                <span className="process-log-role" style={{ color }}>{entry.role}</span>
                <span className="process-log-type">{entry.type}</span>
                <span className="process-log-content">{entry.content}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
