import { useState, useEffect } from "react";
import { apiGet } from "../hooks/useApi";
import { LoopEvent } from "../hooks/useWebSocket";
import { CooldownBanner } from "./CooldownBanner";

interface VersionInfo {
  version: string;
  gitHash: string;
  gitBranch: string;
  buildTime: string;
}

interface LoopStatus {
  state: string;
  rateLimitUntil?: string;
  version?: VersionInfo;
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
  compact?: boolean;
}

export function SystemStatus({ lastEvent, compact }: SystemStatusProps) {
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [rateLimitUntil, setRateLimitUntil] = useState<string | null>(null);

  useEffect(() => {
    apiGet<LoopStatus>("/api/loop/status").then((s) => {
      setStatus(s);
      if (s.rateLimitUntil) setRateLimitUntil(s.rateLimitUntil);
    }).catch(() => {});
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

  if (compact) {
    return (
      <div className="system-status system-status-compact">
        <CooldownBanner rateLimitUntil={rateLimitUntil} />
        <span className="status-badge" data-testid="loop-state">{status.state}</span>
        {status.version && (
          <span className="version-compact" title={`v${status.version.version} (${status.version.gitBranch})\n${status.version.gitHash}\nBuilt: ${new Date(status.version.buildTime).toLocaleString()}`}>
            v{status.version.version} ({status.version.gitHash})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="system-status">
      <div className="status-state" data-testid="loop-state">{status.state}</div>
      <div className="status-metrics">
        <span>Cycles: {status.metrics.totalCycles}</span>
        <span>Success: {status.metrics.successfulCycles}</span>
        <span>Failed: {status.metrics.failedCycles}</span>
        <span>Idle: {status.metrics.idleCycles}</span>
        <span>Audits: {status.metrics.superegoAudits}</span>
      </div>
      {status.version && (
        <div className="status-version">
          <span>v{status.version.version}</span>
          <span className="version-hash" title={`Branch: ${status.version.gitBranch}\nBuild: ${new Date(status.version.buildTime).toLocaleString()}`}>
            {status.version.gitHash}
          </span>
        </div>
      )}
    </div>
  );
}
