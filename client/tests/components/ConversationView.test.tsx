import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationView } from "../../src/components/ConversationView";

describe("ConversationView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("displays conversation entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rawMarkdown: "# Conversation\n\n[2025-01-01] [EGO] Hello there",
      }),
    } as Response);

    render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-entries")).toHaveTextContent("Hello there");
    });
  });

  it("appends SUBCONSCIOUS text process_output to conversation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rawMarkdown: "# Conversation\n\n" }),
    } as Response);

    const { rerender } = render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("No conversation yet.")).toBeInTheDocument();
    });

    // Simulate a SUBCONSCIOUS text process_output event
    rerender(
      <ConversationView
        lastEvent={{
          type: "process_output",
          timestamp: "2025-06-15T10:00:01.000Z",
          data: {
            role: "SUBCONSCIOUS",
            cycleNumber: 1,
            entry: { type: "text", content: "I completed the authentication module" },
          },
        }}
        refreshKey={0}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("conversation-entries")).toHaveTextContent(
        "I completed the authentication module"
      );
    });
  });

  it("does not append non-text process_output to conversation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rawMarkdown: "# Conversation\n\n" }),
    } as Response);

    const { rerender } = render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("No conversation yet.")).toBeInTheDocument();
    });

    // Simulate a thinking event — should NOT appear in conversation
    rerender(
      <ConversationView
        lastEvent={{
          type: "process_output",
          timestamp: "2025-06-15T10:00:01.000Z",
          data: {
            role: "SUBCONSCIOUS",
            cycleNumber: 1,
            entry: { type: "thinking", content: "internal reasoning" },
          },
        }}
        refreshKey={0}
      />
    );

    expect(screen.getByText("No conversation yet.")).toBeInTheDocument();
  });

  it("shows empty state when no entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rawMarkdown: "# Conversation\n\n" }),
    } as Response);

    render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("No conversation yet.")).toBeInTheDocument();
    });
  });
});
