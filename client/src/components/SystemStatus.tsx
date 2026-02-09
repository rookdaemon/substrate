import { useState, useEffect } from "react";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";
import { CooldownBanner } from "./CooldownBanner";

interface LoopStatus {
  state: string;
  metrics: {
    totalCycles: number;
    successfulCycles: number;
    failedCycles: number;
    idleCycles: number;
    consecutiveIdleCycles: number;
    superegoAudits: number;
  };
}

interface SystemStatusProps {
  lastEvent: LoopEvent | null;
}

export function SystemStatus({ lastEvent }: SystemStatusProps) {
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [rateLimitUntil, setRateLimitUntil] = useState<string | null>(null);

  useEffect(() => {
    apiGet<LoopStatus>("/api/loop/status").then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (lastEvent?.type === "state_changed" || lastEvent?.type === "cycle_complete") {
      apiGet<LoopStatus>("/api/loop/status").then(setStatus).catch(() => {});
    }
    // Pick up rate limit from idle events
    if (lastEvent?.type === "idle" && lastEvent.data.rateLimitUntil) {
      setRateLimitUntil(lastEvent.data.rateLimitUntil as string);
    }
    // Clear cooldown when a cycle completes successfully or state changes to running
    if (lastEvent?.type === "cycle_complete" || lastEvent?.type === "tick_complete") {
      setRateLimitUntil(null);
    }
  }, [lastEvent]);

  if (!status) return <div>Loading...</div>;

  return (
    <div className="system-status">
      <h2>System Status</h2>
      <CooldownBanner rateLimitUntil={rateLimitUntil} />
      <div className="status-state" data-testid="loop-state">{status.state}</div>
      <div className="status-metrics">
        <span>Cycles: {status.metrics.totalCycles}</span>
        <span>Success: {status.metrics.successfulCycles}</span>
        <span>Failed: {status.metrics.failedCycles}</span>
        <span>Idle: {status.metrics.idleCycles}</span>
        <span>Audits: {status.metrics.superegoAudits}</span>
      </div>
    </div>
  );
}
