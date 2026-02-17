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

  return (
    <div className="loop-controls">
      <button
        onClick={() => handleAction("start")}
        disabled={state !== "STOPPED" && !rateLimitUntil}
      >
        {rateLimitUntil ? "Try Again" : "Start"}
      </button>
      <button
        onClick={() => handleAction("pause")}
        disabled={state !== "RUNNING"}
      >
        Pause
      </button>
      <button
        onClick={() => handleAction("resume")}
        disabled={state !== "PAUSED"}
      >
        Resume
      </button>
      <button
        onClick={() => handleAction("stop")}
        disabled={state === "STOPPED"}
      >
        Stop
      </button>
      <button
        className="btn-restart"
        onClick={() => handleAction("restart")}
      >
        Restart
      </button>
    </div>
  );
}
