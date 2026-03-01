import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateDetector } from "../../src/environment/StateDetector";

describe("StateDetector", () => {
  let detector: StateDetector;

  beforeEach(() => {
    detector = new StateDetector("/api/state");
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
    vi.clearAllMocks();
  });

  it("should fetch state from API successfully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        agentName: "test-agent",
        mode: "cycle",
        initialized: true,
      }),
    });

    const state = await detector.detectState();
    expect(state.agentName).toBe("test-agent");
    expect(state.source).toBe("api");
  });

  it("should fallback to default on API failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const state = await detector.detectState();
    expect(state.source).toBe("default");
    expect(state.initialized).toBe(false);
  });
});
