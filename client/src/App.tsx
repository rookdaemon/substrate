import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { apiGet } from "./hooks/useApi";
import { useNotifications } from "./hooks/useNotifications";
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
import "./App.css";

function getWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function App() {
  const { lastEvent, connected } = useWebSocket(getWsUrl());
  const { notifications, dismiss } = useNotifications(lastEvent);
  const [loopState, setLoopState] = useState("STOPPED");
  const [conversationKey, setConversationKey] = useState(0);

  const refreshState = useCallback(() => {
    apiGet<{ state: string }>("/api/loop/status")
      .then((data) => setLoopState(data.state))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (lastEvent?.type === "state_changed") {
      refreshState();
    }
  }, [lastEvent, refreshState]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Rook Wiggums</h1>
        <span className={`ws-status ${connected ? "connected" : "disconnected"}`}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </header>

      <main className="app-grid">
        <section className="panel panel-status">
          <SystemStatus lastEvent={lastEvent} />
          <LoopControls state={loopState} onStateChange={refreshState} />
          <HealthIndicators />
        </section>

        <section className="panel panel-plan">
          <PlanView lastEvent={lastEvent} />
        </section>

        <section className="panel panel-progress">
          <ProgressLog lastEvent={lastEvent} />
        </section>

        <section className="panel panel-conversation">
          <ConversationView lastEvent={lastEvent} refreshKey={conversationKey} />
          <InputField onSent={() => setConversationKey((k) => k + 1)} />
        </section>

        <section className="panel panel-process-log">
          <ProcessLog lastEvent={lastEvent} />
        </section>

        <section className="panel panel-substrate">
          <SubstrateViewer />
        </section>
      </main>

      <NotificationToast notifications={notifications} onDismiss={dismiss} />
    </div>
  );
}
