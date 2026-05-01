import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubstrateViewer } from "../../src/components/SubstrateViewer";

describe("SubstrateViewer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders dropdown with all file types", () => {
    render(<SubstrateViewer />);

    const select = screen.getByTestId("substrate-select");
    expect(select).toBeInTheDocument();

    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(15);
    expect(Array.from(options).map((option) => option.value)).toContain("OPERATING_CONTEXT");
  });

  it("defaults to PLAN selection", () => {
    render(<SubstrateViewer />);

    const select = screen.getByTestId("substrate-select") as HTMLSelectElement;
    expect(select.value).toBe("PLAN");
  });
});
