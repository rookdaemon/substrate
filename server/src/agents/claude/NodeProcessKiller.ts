import { ProcessKiller } from "./ProcessTracker";

/**
 * ProcessKiller implementation using Node.js process.kill
 */
export class NodeProcessKiller implements ProcessKiller {
  isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 doesn't kill, just checks if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH means process doesn't exist
      return false;
    }
  }

  killProcess(pid: number, signal: string): void {
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch {
      // Ignore errors (process might already be dead)
      // Caller can check isProcessAlive if needed
    }
  }
}
