import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { apiGet } from "./hooks/useApi";
import { useNotifications } from "./hooks/useNotifications";
import { usePanelState } from "./hooks/usePanelState";
import { SystemStatus } from "./components/SystemStatus";
import { LoopControls } from "./components/LoopControls";
import { PlanView } from "./components/PlanView";
import { ProgressLog } from "./components/ProgressLog";
import { ConversationView } from "./components/ConversationView";
import { InputField } from "./components/InputField";
import { SubstrateViewer } from "./components/SubstrateViewer";
import { HealthIndicators } from "./components/HealthIndicators";
import { ProcessLog } from "./components/ProcessLog";
import { NotificationToast } from "./components/NotificationToast";
import { CollapsiblePanel } from "./components/CollapsiblePanel";
import "./App.css";

function getWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function App() {
  const { lastEvent, connected, reconnecting, reconnect } = useWebSocket(getWsUrl());
  const { notifications, dismiss } = useNotifications(lastEvent);
  const { togglePanel, isExpanded } = usePanelState();
  const [loopState, setLoopState] = useState("STOPPED");
  const [rateLimitUntil, setRateLimitUntil] = useState<string | null>(null);
  const [conversationKey, setConversationKey] = useState(0);

  const refreshState = useCallback(() => {
    apiGet<{ state: string; rateLimitUntil?: string }>("/api/loop/status")
      .then((data) => {
        setLoopState(data.state);
        setRateLimitUntil(data.rateLimitUntil || null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (lastEvent?.type === "state_changed") {
      refreshState();
    }
    // Pick up rate limit from idle events
    if (lastEvent?.type === "idle" && lastEvent.data.rateLimitUntil) {
      setRateLimitUntil(lastEvent.data.rateLimitUntil as string);
    }
    // Clear rate limit when cycle completes successfully
    if (lastEvent?.type === "cycle_complete" || lastEvent?.type === "tick_complete") {
      setRateLimitUntil(null);
    }
  }, [lastEvent, refreshState]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Substrate</h1>
        <span 
          className={`ws-status ${connected ? "connected" : "disconnected"} ${reconnecting ? "reconnecting" : ""}`}
          onClick={!connected && !reconnecting ? reconnect : undefined}
          style={!connected && !reconnecting ? { cursor: "pointer", textDecoration: "underline" } : undefined}
          title={!connected && !reconnecting ? "Click to reconnect" : undefined}
        >
          {connected ? "Connected" : reconnecting ? "Reconnecting..." : "Disconnected"}
        </span>
      </header>

      <main className="app-layout">
        <section className="panel panel-status">
          <div className="status-bar">
            <SystemStatus lastEvent={lastEvent} compact />
            <LoopControls state={loopState} rateLimitUntil={rateLimitUntil} onStateChange={refreshState} />
          </div>
          <details className="status-details">
            <summary>Metrics & Health</summary>
            <SystemStatus lastEvent={lastEvent} />
            <HealthIndicators />
          </details>
        </section>

        <div className="panel-row">
          <CollapsiblePanel
            panelId="plan"
            title="Plan"
            isExpanded={isExpanded("plan")}
            onToggle={togglePanel}
            collapseDirection="up"
            className="panel-plan"
          >
            <PlanView lastEvent={lastEvent} />
          </CollapsiblePanel>

          <CollapsiblePanel
            panelId="progress"
            title="Progress Log"
            isExpanded={isExpanded("progress")}
            onToggle={togglePanel}
            collapseDirection="right"
            className="panel-progress"
          >
            <ProgressLog lastEvent={lastEvent} />
          </CollapsiblePanel>
        </div>

        <div className="panel-row">
          <CollapsiblePanel
            panelId="conversation"
            title="Conversation"
            isExpanded={isExpanded("conversation")}
            onToggle={togglePanel}
            collapseDirection="up"
            className="panel-conversation"
          >
            <ConversationView lastEvent={lastEvent} refreshKey={conversationKey} />
            <InputField onSent={() => setConversationKey((k) => k + 1)} />
          </CollapsiblePanel>
        </div>

        <CollapsiblePanel
          panelId="processLog"
          title="Process Log"
          isExpanded={isExpanded("processLog")}
          onToggle={togglePanel}
          collapseDirection="up"
          className="panel-process-log"
        >
          <ProcessLog lastEvent={lastEvent} />
        </CollapsiblePanel>

        <CollapsiblePanel
          panelId="substrate"
          title="Substrate Viewer"
          isExpanded={isExpanded("substrate")}
          onToggle={togglePanel}
          collapseDirection="up"
          className="panel-substrate"
        >
          <SubstrateViewer lastEvent={lastEvent} />
        </CollapsiblePanel>
      </main>

      <NotificationToast notifications={notifications} onDismiss={dismiss} />
    </div>
  );
}
