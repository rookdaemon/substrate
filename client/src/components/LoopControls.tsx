import { apiPost } from "../hooks/useApi";

interface LoopControlsProps {
  state: string;
  rateLimitUntil?: string | null;
  onStateChange: () => void;
}

export function LoopControls({ state, rateLimitUntil, onStateChange }: LoopControlsProps) {
  const handleAction = async (action: string) => {
    try {
      await apiPost(`/api/loop/${action}`);
      onStateChange();
    } catch {
      // ignore errors — state will refresh
    }
  };

  // Determine primary button action and label based on state
  const getPrimaryAction = () => {
    if (state === "STOPPED" || rateLimitUntil) {
      return { action: "start", label: rateLimitUntil ? "Try Again" : "Start" };
    } else if (state === "RUNNING") {
      return { action: "pause", label: "Pause" };
    } else if (state === "PAUSED") {
      return { action: "resume", label: "Resume" };
    }
    return { action: "start", label: "Start" };
  };

  const primary = getPrimaryAction();

  return (
    <div className="loop-controls">
      <button
        onClick={() => handleAction(primary.action)}
        className="btn-primary"
      >
        {primary.label}
      </button>
      <button
        onClick={() => handleAction("stop")}
        disabled={state === "STOPPED"}
        className="btn-secondary"
      >
        Stop
      </button>
      <button
        className="btn-restart"
        onClick={() => handleAction("restart")}
        title="Restart server process"
      >
        Restart
      </button>
    </div>
  );
}
