import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanelState } from "../../src/hooks/usePanelState";

describe("usePanelState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("initializes with default states", () => {
    const { result } = renderHook(() => usePanelState());
    
    expect(result.current.isExpanded("plan")).toBe(true);
    expect(result.current.isExpanded("progress")).toBe(true);
    expect(result.current.isExpanded("conversation")).toBe(true);
    expect(result.current.isExpanded("processLog")).toBe(false);
    expect(result.current.isExpanded("substrate")).toBe(false);
  });

  it("toggles panel state", () => {
    const { result } = renderHook(() => usePanelState());
    
    act(() => {
      result.current.togglePanel("plan");
    });
    
    expect(result.current.isExpanded("plan")).toBe(false);
    
    act(() => {
      result.current.togglePanel("plan");
    });
    
    expect(result.current.isExpanded("plan")).toBe(true);
  });

  it("persists state to localStorage", () => {
    const { result } = renderHook(() => usePanelState());
    
    act(() => {
      result.current.togglePanel("processLog");
    });
    
    const stored = localStorage.getItem("substrate-panel-states");
    expect(stored).toBeTruthy();
    
    const parsed = JSON.parse(stored!);
    expect(parsed.processLog).toBe(true);
  });

  it("loads state from localStorage", () => {
    const initialState = {
      plan: false,
      progress: true,
      conversation: false,
      processLog: true,
      substrate: true,
    };
    
    localStorage.setItem("substrate-panel-states", JSON.stringify(initialState));
    
    const { result } = renderHook(() => usePanelState());
    
    expect(result.current.isExpanded("plan")).toBe(false);
    expect(result.current.isExpanded("progress")).toBe(true);
    expect(result.current.isExpanded("conversation")).toBe(false);
    expect(result.current.isExpanded("processLog")).toBe(true);
    expect(result.current.isExpanded("substrate")).toBe(true);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("substrate-panel-states", "corrupted-json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => usePanelState());

    // Should fall back to defaults
    expect(result.current.isExpanded("plan")).toBe(true);
    expect(result.current.isExpanded("processLog")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to load panel states from localStorage:",
      expect.any(SyntaxError)
    );
    warnSpy.mockRestore();
  });

  it("merges partial state from localStorage with defaults", () => {
    const partialState = {
      plan: false,
    };
    
    localStorage.setItem("substrate-panel-states", JSON.stringify(partialState));
    
    const { result } = renderHook(() => usePanelState());
    
    // Should use stored value for plan
    expect(result.current.isExpanded("plan")).toBe(false);
    // Should use defaults for others
    expect(result.current.isExpanded("progress")).toBe(true);
    expect(result.current.isExpanded("processLog")).toBe(false);
  });
});
