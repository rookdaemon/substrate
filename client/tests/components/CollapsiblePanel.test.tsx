import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CollapsiblePanel } from "../../src/components/CollapsiblePanel";

describe("CollapsiblePanel", () => {
  it("renders the panel title", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    expect(screen.getByText("Test Panel")).toBeInTheDocument();
  });

  it("renders children when expanded", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
      >
        <div>Test Content</div>
      </CollapsiblePanel>
    );
    
    expect(screen.getByText("Test Content")).toBeInTheDocument();
  });

  it("hides children when collapsed", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={false}
        onToggle={onToggle}
      >
        <div>Test Content</div>
      </CollapsiblePanel>
    );
    
    expect(screen.queryByText("Test Content")).not.toBeInTheDocument();
  });

  it("calls onToggle when toggle button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const toggleButton = screen.getByRole("button", { name: /collapse test panel/i });
    fireEvent.click(toggleButton);
    
    expect(onToggle).toHaveBeenCalledWith("plan");
  });

  it("shows correct icon for upward collapse direction when expanded", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
        collapseDirection="up"
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const toggleButton = screen.getByRole("button", { name: /collapse test panel/i });
    expect(toggleButton.textContent).toBe("↑");
  });

  it("shows correct icon for rightward collapse direction when expanded", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="progress"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
        collapseDirection="right"
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const toggleButton = screen.getByRole("button", { name: /collapse test panel/i });
    expect(toggleButton.textContent).toBe("→");
  });

  it("shows correct icon when collapsed (upward)", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={false}
        onToggle={onToggle}
        collapseDirection="up"
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const toggleButton = screen.getByRole("button", { name: /expand test panel/i });
    expect(toggleButton.textContent).toBe("↓");
  });

  it("renders vertical strip when collapsed rightward", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel
        panelId="progress"
        title="Test Panel"
        isExpanded={false}
        onToggle={onToggle}
        collapseDirection="right"
      >
        <div>Content</div>
      </CollapsiblePanel>
    );

    const stripButton = screen.getByRole("button", { name: /expand test panel/i });
    expect(stripButton).toBeInTheDocument();
    expect(screen.getByText("Test Panel")).toBeInTheDocument();
    expect(screen.getByText("←")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
        className="custom-class"
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const panel = container.querySelector(".custom-class");
    expect(panel).toBeInTheDocument();
  });

  it("applies expanded class when expanded", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={true}
        onToggle={onToggle}
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const panel = container.querySelector(".expanded");
    expect(panel).toBeInTheDocument();
  });

  it("applies collapsed class when collapsed", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsiblePanel
        panelId="plan"
        title="Test Panel"
        isExpanded={false}
        onToggle={onToggle}
      >
        <div>Content</div>
      </CollapsiblePanel>
    );
    
    const panel = container.querySelector(".collapsed");
    expect(panel).toBeInTheDocument();
  });
});
