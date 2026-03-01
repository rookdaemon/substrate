import { useState, useEffect, useCallback } from "react";
import { stateDetector, SystemState } from "../environment/StateDetector";

export interface UseSystemStateResult {
  state: SystemState | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * React hook for accessing system state with automatic fallback mechanisms
 * 
 * @param refreshInterval - Auto-refresh interval in milliseconds (default: 30000 = 30s)
 * @returns System state, loading status, error, and refresh function
 */
export function useSystemState(refreshInterval: number = 30000): UseSystemStateResult {
  const [state, setState] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const detected = await stateDetector.detectState();
      setState(detected);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      // Even on error, try to use cached or default state
      try {
        const fallback = await stateDetector.detectState();
        setState(fallback);
      } catch {
        // Complete failure - set to null
        setState(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on interval (only if enabled)
  useEffect(() => {
    if (refreshInterval <= 0) {
      return;
    }

    const timer = setInterval(refresh, refreshInterval);
    return () => clearInterval(timer);
  }, [refresh, refreshInterval]);

  return { state, loading, error, refresh };
}
