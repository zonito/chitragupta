import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SpendTimelineSection } from "@/components/spend-chart";
import {
  chartStateKey,
  restoreChartState,
  serializeChartState,
} from "@/lib/chart-state";
import type { ChartPreset, MonthlyRows } from "@/lib/timeline";

/**
 * The shared chart persists its interactive state (preset + isolated
 * category) per surface in localStorage: a refresh or revisit shows
 * the same view. Restore is validated against current data — a stale
 * preset or a category that no longer exists falls back cleanly.
 */

const MONTHLY: MonthlyRows = {
  months: ["2026-08", "2026-09", "2026-10"],
  rows: [
    { category: "Groceries", series: [300, 320, 340] },
    { category: "Home", series: [100, 110, 120] },
  ],
};
const ALL_PRESETS: ChartPreset[] = [
  "daily",
  "monthly",
  "quarterly",
  "ytd",
  "oneyear",
  "all",
];
const legendFor = (names: string[]) => () => names;

beforeEach(() => {
  localStorage.clear();
});

describe("restoreChartState (validation maths)", () => {
  it("round-trips a valid stored state", () => {
    const raw = serializeChartState({
      preset: "quarterly",
      selected: "Groceries",
    });
    expect(
      restoreChartState(
        raw,
        ALL_PRESETS,
        "monthly",
        legendFor(["Groceries", "Home"]),
      ),
    ).toEqual({ preset: "quarterly", selected: "Groceries" });
  });

  it("drops a stale category but keeps a valid preset", () => {
    const raw = serializeChartState({
      preset: "quarterly",
      selected: "Atlantis",
    });
    expect(
      restoreChartState(raw, ALL_PRESETS, "monthly", legendFor(["Groceries"])),
    ).toEqual({ preset: "quarterly", selected: null });
  });

  it("drops a preset the surface does not offer, with its selection", () => {
    const raw = serializeChartState({ preset: "daily", selected: "Groceries" });
    expect(
      restoreChartState(
        raw,
        ["monthly", "quarterly"],
        "monthly",
        legendFor(["Groceries"]),
      ),
    ).toEqual({ preset: "monthly", selected: null });
  });

  it("corrupt or missing storage yields the defaults", () => {
    expect(
      restoreChartState("{nope", ALL_PRESETS, "monthly", legendFor([])),
    ).toEqual({
      preset: "monthly",
      selected: null,
    });
    expect(
      restoreChartState(null, ALL_PRESETS, "monthly", legendFor([])),
    ).toEqual({
      preset: "monthly",
      selected: null,
    });
  });
});

describe("SpendTimelineSection persistence", () => {
  const renderSection = (surface: "categories" | "home" | "subscriptions") =>
    render(
      <SpendTimelineSection
        title="Spending over time"
        surface={surface}
        monthly={MONTHLY}
        {...(surface === "subscriptions"
          ? {}
          : { dailyPerson: "household" as const })}
      />,
    );

  it("restores the saved preset and isolation on remount", () => {
    const first = renderSection("categories");
    fireEvent.click(screen.getByRole("button", { name: "Quarterly" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries ·/ }));
    expect(
      JSON.parse(localStorage.getItem(chartStateKey("categories"))!),
    ).toEqual({ preset: "quarterly", selected: "Groceries" });
    first.unmount();

    renderSection("categories");
    expect(screen.getByRole("button", { name: "Quarterly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /Groceries ·/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The readout reflects the isolation, not the stacked total.
    expect(screen.getByText(/on Groceries/)).toBeTruthy();
  });

  it("a stale stored category falls back to the stacked view, preset kept", () => {
    localStorage.setItem(
      chartStateKey("categories"),
      serializeChartState({ preset: "quarterly", selected: "Atlantis" }),
    );
    renderSection("categories");
    expect(screen.getByRole("button", { name: "Quarterly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const b of screen.getAllByRole("button", { name: /· £/ })) {
      expect(b).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.queryByText(/Atlantis/)).toBeNull();
  });

  it("a stored Daily preset falls back on a surface without Daily", () => {
    localStorage.setItem(
      chartStateKey("subscriptions"),
      serializeChartState({ preset: "daily", selected: null }),
    );
    renderSection("subscriptions");
    expect(screen.queryByRole("button", { name: "Daily" })).toBeNull();
    expect(screen.getByRole("button", { name: "Monthly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("surfaces keep separate keys: one surface's state never leaks into another", () => {
    localStorage.setItem(
      chartStateKey("categories"),
      serializeChartState({ preset: "quarterly", selected: "Groceries" }),
    );
    renderSection("home");
    // Home starts at its own defaults despite the Categories state.
    expect(screen.getByRole("button", { name: "Monthly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "YTD" }));
    expect(JSON.parse(localStorage.getItem(chartStateKey("home"))!)).toEqual({
      preset: "ytd",
      selected: null,
    });
    // The Categories key is untouched by the Home interaction.
    expect(
      JSON.parse(localStorage.getItem(chartStateKey("categories"))!),
    ).toEqual({
      preset: "quarterly",
      selected: "Groceries",
    });
  });
});
