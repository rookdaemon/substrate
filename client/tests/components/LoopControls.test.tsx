import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { LoopControls } from "../../src/components/LoopControls";

describe("LoopControls", () => {
  it("shows Start button when STOPPED", () => {
    render(<LoopControls state="STOPPED" onStateChange={vi.fn()} />);

    expect(screen.getByText("Start")).not.toBeDisabled();
    expect(screen.getByText("Stop")).toBeDisabled();
    expect(screen.queryByText("Pause")).not.toBeInTheDocument();
    expect(screen.queryByText("Resume")).not.toBeInTheDocument();
  });

  it("shows Pause button when RUNNING", () => {
    render(<LoopControls state="RUNNING" onStateChange={vi.fn()} />);

    expect(screen.getByText("Pause")).not.toBeDisabled();
    expect(screen.getByText("Stop")).not.toBeDisabled();
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.queryByText("Resume")).not.toBeInTheDocument();
  });

  it("shows Resume button when PAUSED", () => {
    render(<LoopControls state="PAUSED" onStateChange={vi.fn()} />);

    expect(screen.getByText("Resume")).not.toBeDisabled();
    expect(screen.getByText("Stop")).not.toBeDisabled();
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.queryByText("Pause")).not.toBeInTheDocument();
  });

  it("shows Try Again when rate limited", () => {
    render(<LoopControls state="RUNNING" rateLimitUntil="2024-01-01T00:00:00Z" onStateChange={vi.fn()} />);

    expect(screen.getByText("Try Again")).not.toBeDisabled();
  });

  it("Restart button is always enabled regardless of state", () => {
    const { rerender } = render(<LoopControls state="STOPPED" onStateChange={vi.fn()} />);
    expect(screen.getByText("Restart")).not.toBeDisabled();

    rerender(<LoopControls state="RUNNING" onStateChange={vi.fn()} />);
    expect(screen.getByText("Restart")).not.toBeDisabled();

    rerender(<LoopControls state="PAUSED" onStateChange={vi.fn()} />);
    expect(screen.getByText("Restart")).not.toBeDisabled();
  });

  it("Restart button calls /api/loop/restart", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const onStateChange = vi.fn();
    render(<LoopControls state="RUNNING" onStateChange={onStateChange} />);

    fireEvent.click(screen.getByText("Restart"));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/loop/restart",
      expect.objectContaining({ method: "POST" }),
    );
    fetchSpy.mockRestore();
  });
});
