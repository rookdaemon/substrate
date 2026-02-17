import { IClock } from "../../substrate/abstractions/IClock";
import { ILogger } from "../../logging";

export interface ProcessTrackerConfig {
  gracePeriodMs: number; // Default: 10 minutes
  reaperIntervalMs?: number; // Optional: how often to check for abandoned processes
}

export interface ProcessKiller {
  /**
   * Check if a process is still running
   * @param pid Process ID
   * @returns true if process is running, false if not found/exited
   */
  isProcessAlive(pid: number): boolean;

  /**
   * Kill a process with the given signal
   * @param pid Process ID
   * @param signal Signal to send (e.g., "SIGTERM", "SIGKILL")
   */
  killProcess(pid: number, signal: string): void;
}

interface AbandonedProcess {
  pid: number;
  abandonedAt: Date;
}

/**
 * Tracks Claude Code session PIDs and kills abandoned processes after grace period
 */
export class ProcessTracker {
  private activePids = new Set<number>();
  private abandonedProcesses: AbandonedProcess[] = [];
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clock: IClock,
    private readonly killer: ProcessKiller,
    private readonly config: ProcessTrackerConfig,
    private readonly logger: ILogger
  ) {}

  /**
   * Register a PID when a session starts
   */
  registerPid(pid: number): void {
    this.logger.debug(`ProcessTracker: registering PID ${pid}`);
    this.activePids.add(pid);
    // Remove from abandoned if it was there
    this.abandonedProcesses = this.abandonedProcesses.filter((p) => p.pid !== pid);
  }

  /**
   * Called when a process exits normally
   */
  onProcessExit(pid: number): void {
    this.logger.debug(`ProcessTracker: process ${pid} exited`);
    this.activePids.delete(pid);
    this.abandonedProcesses = this.abandonedProcesses.filter((p) => p.pid !== pid);
  }

  /**
   * Called when a session is abandoned (idle timeout, error, etc.)
   */
  abandonPid(pid: number): void {
    if (!this.activePids.has(pid)) {
      this.logger.debug(`ProcessTracker: PID ${pid} not in active set, ignoring abandon`);
      return;
    }

    this.logger.debug(`ProcessTracker: abandoning PID ${pid}`);
    this.activePids.delete(pid);
    this.abandonedProcesses.push({
      pid,
      abandonedAt: this.clock.now(),
    });

    // Start reaper if not already running
    this.startReaper();
  }

  /**
   * Start the reaper timer to periodically check and kill abandoned processes
   */
  private startReaper(): void {
    if (this.reaperTimer !== null) {
      return; // Already running
    }

    const intervalMs = this.config.reaperIntervalMs ?? 60_000; // Default: check every minute
    this.reaperTimer = setInterval(() => {
      this.reap();
    }, intervalMs);

    // Also reap immediately
    this.reap();
  }

  /**
   * Check abandoned processes and kill those past grace period
   */
  private reap(): void {
    const now = this.clock.now();
    const gracePeriodMs = this.config.gracePeriodMs;
    const toKill: number[] = [];
    const stillAlive: AbandonedProcess[] = [];

    for (const abandoned of this.abandonedProcesses) {
      const ageMs = now.getTime() - abandoned.abandonedAt.getTime();
      if (ageMs >= gracePeriodMs) {
        // Past grace period — check if still running
        if (this.killer.isProcessAlive(abandoned.pid)) {
          toKill.push(abandoned.pid);
        }
        // If not alive, just remove from list (process already exited)
      } else {
        stillAlive.push(abandoned);
      }
    }

    // Kill processes that are past grace period and still running
    for (const pid of toKill) {
      this.logger.debug(`ProcessTracker: killing abandoned PID ${pid} (past grace period)`);
      try {
        this.killer.killProcess(pid, "SIGTERM");
        // Give it a moment, then SIGKILL if still alive
        setTimeout(() => {
          if (this.killer.isProcessAlive(pid)) {
            this.logger.debug(`ProcessTracker: PID ${pid} still alive after SIGTERM, sending SIGKILL`);
            this.killer.killProcess(pid, "SIGKILL");
          }
        }, 2000);
      } catch (err) {
        this.logger.debug(`ProcessTracker: error killing PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update abandoned list (remove killed ones and ones that exited)
    this.abandonedProcesses = stillAlive;

    // Stop reaper if no abandoned processes left
    if (this.abandonedProcesses.length === 0 && this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /**
   * Stop the reaper and clean up
   */
  stop(): void {
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /**
   * Get all currently tracked PIDs (for debugging)
   */
  getActivePids(): number[] {
    return Array.from(this.activePids);
  }

  /**
   * Get all abandoned PIDs (for debugging)
   */
  getAbandonedPids(): number[] {
    return this.abandonedProcesses.map((p) => p.pid);
  }
}
