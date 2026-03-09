import { useState, useEffect, useCallback } from "react";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";

const FILE_TYPES = [
  "BOUNDARIES", "CHARTER", "CLAUDE", "CONVERSATION",
  "HABITS", "ID", "MEMORY", "PLAN", "PROGRESS",
  "SECURITY", "SKILLS", "SUPEREGO", "VALUES",
];

interface SubstrateContent {
  rawMarkdown: string;
  meta: { fileType: string };
}

interface SubstrateViewerProps {
  lastEvent: LoopEvent | null;
}

export function SubstrateViewer({ lastEvent }: SubstrateViewerProps) {
  const [selected, setSelected] = useState("PLAN");
  const [content, setContent] = useState("");

  const loadFile = useCallback(async (fileType: string) => {
    try {
      const data = await apiGet<SubstrateContent>(`/api/substrate/${fileType}`);
      setContent(data.rawMarkdown);
    } catch {
      setContent("(unable to load)");
    }
  }, []);

  const handleSelect = async (fileType: string) => {
    setSelected(fileType);
    await loadFile(fileType);
  };

  // Load initial file
  useEffect(() => {
    loadFile(selected);
  }, [selected, loadFile]);

  // Refresh when the selected file changes on disk
  useEffect(() => {
    if (lastEvent?.type === "file_changed" && 
        lastEvent.data.fileType === selected) {
      loadFile(selected);
    }
  }, [lastEvent, selected, loadFile]);

  return (
    <div className="substrate-viewer">
      <select
        value={selected}
        onChange={(e) => handleSelect(e.target.value)}
        data-testid="substrate-select"
      >
        {FILE_TYPES.map((ft) => (
          <option key={ft} value={ft}>{ft}</option>
        ))}
      </select>
      <pre className="substrate-content" data-testid="substrate-content">{content}</pre>
    </div>
  );
}
