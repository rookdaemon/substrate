/**
 * StateDetector: Fallback mechanism for detecting system state when direct file access is unavailable.
 * 
 * Priority order:
 * 1. API endpoint (/api/state)
 * 2. Environment variables (VITE_SUBSTRATE_STATE_*)
 * 3. LocalStorage cache (browser persistence)
 * 4. Minimal default state
 */

export interface SystemState {
  agentName?: string;
  mode?: "cycle" | "tick";
  initialized: boolean;
  timestamp: number;
  source: "api" | "env" | "cache" | "default";
}

export interface IStateDetector {
  /** Detect current system state using available fallback mechanisms */
  detectState(): Promise<SystemState>;
  /** Cache state for offline access */
  cacheState(state: SystemState): void;
  /** Clear cached state */
  clearCache(): void;
}

export class StateDetector implements IStateDetector {
  private readonly apiEndpoint: string;
  private readonly cacheKey: string = "substrate_system_state";
  private readonly envPrefix: string = "VITE_SUBSTRATE_STATE_";

  constructor(apiEndpoint: string = "/api/state") {
    this.apiEndpoint = apiEndpoint;
  }

  async detectState(): Promise<SystemState> {
    // 1. Try API endpoint first (most accurate, real-time)
    try {
      const state = await this.fetchFromApi();
      if (state) {
        this.cacheState(state);
        return state;
      }
    } catch (err) {
      console.debug("[StateDetector] API unavailable:", err);
    }

    // 2. Try environment variables (build-time injection)
    try {
      const state = this.readFromEnv();
      if (state) {
        return state;
      }
    } catch (err) {
      console.debug("[StateDetector] Env variables unavailable:", err);
    }

    // 3. Try localStorage cache (persisted from previous session)
    try {
      const state = this.readFromCache();
      if (state) {
        return state;
      }
    } catch (err) {
      console.debug("[StateDetector] Cache unavailable:", err);
    }

    // 4. Return minimal default state
    return this.getDefaultState();
  }

  private async fetchFromApi(): Promise<SystemState | null> {
    const response = await fetch(this.apiEndpoint, {
      method: "GET",
      headers: { "Accept": "application/json" },
      // Add authorization if API token is available
      ...(this.getApiToken() ? { headers: { Authorization: `Bearer ${this.getApiToken()}` } } : {}),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      agentName: data.agentName,
      mode: data.mode,
      initialized: data.initialized ?? true,
      timestamp: Date.now(),
      source: "api",
    };
  }

  private readFromEnv(): SystemState | null {
    const meta = import.meta as unknown as { env?: Record<string, unknown> };
    const env = meta.env;
    
    if (!env) {
      return null;
    }

    const agentName = env[`${this.envPrefix}AGENT_NAME`];
    const mode = env[`${this.envPrefix}MODE`];
    const initialized = env[`${this.envPrefix}INITIALIZED`];

    // Only return state if at least one env var is set
    if (!agentName && !mode && !initialized) {
      return null;
    }

    return {
      agentName: agentName ? String(agentName) : undefined,
      mode: mode === "cycle" || mode === "tick" ? mode : undefined,
      initialized: initialized === "true" || initialized === "1",
      timestamp: Date.now(),
      source: "env",
    };
  }

  private readFromCache(): SystemState | null {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }

    const cached = window.localStorage.getItem(this.cacheKey);
    if (!cached) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached);
      // Validate cached data is not too old (24 hours)
      const age = Date.now() - (parsed.timestamp ?? 0);
      if (age > 24 * 60 * 60 * 1000) {
        this.clearCache();
        return null;
      }

      return {
        ...parsed,
        source: "cache",
      };
    } catch {
      this.clearCache();
      return null;
    }
  }

  cacheState(state: SystemState): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.setItem(this.cacheKey, JSON.stringify(state));
    } catch (err) {
      console.debug("[StateDetector] Failed to cache state:", err);
    }
  }

  clearCache(): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.removeItem(this.cacheKey);
    } catch (err) {
      console.debug("[StateDetector] Failed to clear cache:", err);
    }
  }

  private getDefaultState(): SystemState {
    return {
      initialized: false,
      timestamp: Date.now(),
      source: "default",
    };
  }

  private getApiToken(): string | undefined {
    const meta = import.meta as unknown as { env?: Record<string, unknown> };
    const token = meta.env?.VITE_API_TOKEN;
    return token ? String(token) : undefined;
  }
}

/**
 * Singleton instance for convenient access
 */
export const stateDetector = new StateDetector();
