import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ProcessLog } from "../../src/components/ProcessLog";

function makeProcessOutputEvent(role: string, type: string, content: string) {
  return {
    type: "process_output" as const,
    timestamp: "2025-06-15T10:00:00.000Z",
    data: {
      role,
      cycleNumber: 1,
      entry: { type, content },
    },
  };
}

describe("ProcessLog", () => {
  it("renders with no entries initially", () => {
    render(<ProcessLog lastEvent={null} />);
    expect(screen.getByText("Process Log")).toBeInTheDocument();
    expect(screen.getByText("No process output yet.")).toBeInTheDocument();
  });

  it("accumulates process_output events", () => {
    const event1 = makeProcessOutputEvent("EGO", "thinking", "analyzing...");
    const { rerender } = render(<ProcessLog lastEvent={event1} />);

    expect(screen.getByText(/analyzing/)).toBeInTheDocument();

    const event2 = makeProcessOutputEvent("SUBCONSCIOUS", "text", "result here");
    rerender(<ProcessLog lastEvent={event2} />);

    expect(screen.getByText(/analyzing/)).toBeInTheDocument();
    expect(screen.getByText(/result here/)).toBeInTheDocument();
  });

  it("shows agent role labels", () => {
    const event = makeProcessOutputEvent("EGO", "thinking", "hmm");
    render(<ProcessLog lastEvent={event} />);

    expect(screen.getByText("EGO")).toBeInTheDocument();
  });

  it("shows entry type badges", () => {
    const event = makeProcessOutputEvent("SUBCONSCIOUS", "tool_use", "bash: ls");
    render(<ProcessLog lastEvent={event} />);

    expect(screen.getByText("tool_use")).toBeInTheDocument();
  });

  it("clears entries when clear button is clicked", () => {
    const event = makeProcessOutputEvent("EGO", "text", "some output");
    render(<ProcessLog lastEvent={event} />);

    expect(screen.getByText(/some output/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear"));

    expect(screen.getByText("No process output yet.")).toBeInTheDocument();
  });

  it("ignores non-process_output events", () => {
    const event = {
      type: "cycle_complete",
      timestamp: "2025-06-15T10:00:00.000Z",
      data: { cycleNumber: 1 },
    };
    render(<ProcessLog lastEvent={event} />);

    expect(screen.getByText("No process output yet.")).toBeInTheDocument();
  });
});
