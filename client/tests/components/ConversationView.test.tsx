import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationView } from "../../src/components/ConversationView";

describe("ConversationView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("displays conversation entries with role dot and message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rawMarkdown: "# Conversation\n\n[2025-01-01T10:00:00.000Z] [EGO] Hello there\n[2025-01-01T10:01:00.000Z] [SUBCONSCIOUS] Done",
      }),
    } as Response);

    render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      const el = screen.getByTestId("conversation-entries");
      expect(el).toHaveTextContent("Hello there");
      expect(el).toHaveTextContent("Done");
      // Should NOT show raw ISO timestamps
      expect(el.textContent).not.toContain("2025-01-01T10:00:00.000Z");
      // Should have role dots, not fat text
      const dots = el.querySelectorAll(".role-dot");
      expect(dots).toHaveLength(2);
      expect(dots[0]).toHaveClass("role-ego");
      expect(dots[1]).toHaveClass("role-subconscious");
    });
  });

  it("does not accumulate streaming process_output events", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rawMarkdown: "# Conversation\n\n" }),
    } as Response);

    const { rerender } = render(<ConversationView lastEvent={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("No conversation yet.")).toBeInTheDocument();
    });

    // Simulate a SUBCONSCIOUS text process_output event — should NOT appear
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

    // Conversation should still be empty — streaming text goes to ProcessLog only
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
