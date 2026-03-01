import { useSystemState } from "../hooks/useSystemState";
import "./SystemStateIndicator.css";

/**
 * SystemStateIndicator: Displays current system state using fallback detection
 * 
 * Shows:
 * - Agent name (if available)
 * - System mode (cycle/tick)
 * - Initialization status
 * - State source (api/env/cache/default)
 */
export function SystemStateIndicator() {
  const { state, loading, error, refresh } = useSystemState(30000);

  if (loading && !state) {
    return (
      <div className="state-indicator loading">
        <span className="spinner">⟳</span> Detecting state...
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="state-indicator error">
        <span className="icon">⚠</span> State detection failed
        <button onClick={refresh} className="retry-btn">Retry</button>
      </div>
    );
  }

  if (!state) {
    return null;
  }

  const statusClass = state.initialized ? "initialized" : "uninitialized";
  const sourceLabel = {
    api: "Live",
    env: "Config",
    cache: "Cached",
    default: "Offline",
  }[state.source] || state.source;

  return (
    <div className={`state-indicator ${statusClass}`} data-testid="system-state">
      <div className="state-main">
        <span className="status-dot" title={state.initialized ? "Running" : "Stopped"}>
          {state.initialized ? "●" : "○"}
        </span>
        <span className="agent-name" data-testid="agent-name">
          {state.agentName || "Unknown Agent"}
        </span>
        {state.mode && (
          <span className="mode-badge" data-testid="mode">
            {state.mode}
          </span>
        )}
      </div>
      <div className="state-meta">
        <span className="source-badge" title={`Data source: ${state.source}`}>
          {sourceLabel}
        </span>
        <button 
          onClick={refresh} 
          className="refresh-btn" 
          title="Refresh state"
          aria-label="Refresh system state"
        >
          ⟳
        </button>
      </div>
    </div>
  );
}
