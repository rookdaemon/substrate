import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CooldownBanner } from "../../src/components/CooldownBanner";

describe("CooldownBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing when no rateLimitUntil", () => {
    const { container } = render(<CooldownBanner rateLimitUntil={null} />);
    expect(container.querySelector(".cooldown-banner")).toBeNull();
  });

  it("shows countdown when rateLimitUntil is in the future", () => {
    vi.setSystemTime(new Date("2026-02-09T18:30:00Z"));

    render(<CooldownBanner rateLimitUntil="2026-02-09T19:00:00Z" />);

    expect(screen.getByTestId("cooldown-banner")).toBeInTheDocument();
    expect(screen.getByTestId("cooldown-banner")).toHaveTextContent("Rate limited");
    expect(screen.getByTestId("cooldown-time")).toHaveTextContent("30:00");
  });

  it("counts down every second", () => {
    vi.setSystemTime(new Date("2026-02-09T18:30:00Z"));

    render(<CooldownBanner rateLimitUntil="2026-02-09T19:00:00Z" />);

    expect(screen.getByTestId("cooldown-time")).toHaveTextContent("30:00");

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByTestId("cooldown-time")).toHaveTextContent("29:50");
  });

  it("disappears when countdown reaches zero", () => {
    vi.setSystemTime(new Date("2026-02-09T18:59:55Z"));

    const { container } = render(<CooldownBanner rateLimitUntil="2026-02-09T19:00:00Z" />);

    expect(screen.getByTestId("cooldown-banner")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(container.querySelector(".cooldown-banner")).toBeNull();
  });

  it("shows hours when wait is long", () => {
    vi.setSystemTime(new Date("2026-02-09T15:00:00Z"));

    render(<CooldownBanner rateLimitUntil="2026-02-09T19:00:00Z" />);

    expect(screen.getByTestId("cooldown-time")).toHaveTextContent("4:00:00");
  });

  it("clears when rateLimitUntil becomes null", () => {
    vi.setSystemTime(new Date("2026-02-09T18:30:00Z"));

    const { container, rerender } = render(
      <CooldownBanner rateLimitUntil="2026-02-09T19:00:00Z" />
    );

    expect(screen.getByTestId("cooldown-banner")).toBeInTheDocument();

    rerender(<CooldownBanner rateLimitUntil={null} />);

    expect(container.querySelector(".cooldown-banner")).toBeNull();
  });
});
