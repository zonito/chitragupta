import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { SpendChart } from "@/components/spend-chart";
import { gbp, hydrateData, type DataSnapshot } from "@/lib/data";
import type { ChartBucket } from "@/lib/timeline";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
      <a href={to} className={className}>{children}</a>
    ),
  };
});

// Imported after the router mock is registered.
const { IncomeSpendingCard } = await import("@/routes/index");

/**
 * The charts' narrow (phone) rendering: SpendChart measures its own
 * width after mount and, below 560px, renders true-pixel geometry
 * with merged buckets, compact ticks and a capped lone outlier.
 * jsdom has no ResizeObserver, so these tests stub one that reports
 * a phone width; without the stub the desktop rendering stands
 * (last test). Flow-card compact nets are CSS-switched spans — both
 * forms live in the DOM, so their texts are asserted here and the
 * no-overlap property is verified in the rendered browser evidence.
 */

class FakeResizeObserver {
  constructor(private cb: (entries: unknown[]) => void) {}
  observe() {
    this.cb([{ contentRect: { width: 350 } }]);
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

/** 30 day buckets, 2–31 Oct 2026: £50 a day, one £3,940 spike day
 * (5 Oct) and one £800 day (15 Oct). */
const dailyBuckets = (): ChartBucket[] =>
  Array.from({ length: 30 }, (_, i) => {
    const day = i + 2;
    const total = day === 5 ? 3940 : day === 15 ? 800 : 50;
    const cat = day === 5 ? "Finance" : day === 15 ? "Transport" : "Groceries";
    return {
      key: `2026-10-${String(day).padStart(2, "0")}`,
      label: `${day} Oct 2026`,
      short: String(day),
      total,
      values: { [cat]: total },
    };
  });

const svgTexts = (c: HTMLElement) =>
  [...c.querySelectorAll("text")].map((t) => t.textContent);

describe("SpendChart at phone width (350px measured)", () => {
  it("merges 30 day buckets into legible bars with summed figures", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { container } = render(
      <SpendChart buckets={dailyBuckets()} selected={null} onSelect={() => {}} />,
    );
    // 30 days merge pairwise into 15 bars (one hit area + title each).
    expect(container.querySelectorAll("title")).toHaveLength(15);
    // The readout defaults to the last merged group, totals summed.
    expect(screen.getByText(/30 Oct 2026 – 31 Oct 2026 — £100\.00/)).toBeTruthy();
    // Legend totals are the unmerged sums: 28×50 + 3940 + 800.
    expect(screen.getByRole("button", { name: `Finance · ${gbp(3940)}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Groceries · ${gbp(28 * 50)}` })).toBeTruthy();
  });

  it("caps the lone spike: break label carries its exact total, ordinary days stay visible", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { container } = render(
      <SpendChart buckets={dailyBuckets()} selected={null} onSelect={() => {}} />,
    );
    // The merged spike group totals £3,990 (£3,940 + the next day's
    // £50): labelled in full above the clipped bar…
    expect(svgTexts(container)).toContain("£3,990.00");
    // …the axis tops out at the cap (£2k compact), not the spike.
    expect(svgTexts(container)).toContain("£2k");
    expect(svgTexts(container)).not.toContain("£5,000");
    // Ordinary £100 groups keep a real bar height against the cap
    // (100/2000 of the ~200px plot ≈ 10px, not the ~2.5px an
    // uncapped £3,990 scale would leave them).
    const heights = [...container.querySelectorAll("rect")]
      .map((r) => Number(r.getAttribute("height")))
      .filter((h) => h > 0 && h < 100);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(8);
  });

  it("uses compact £k tick labels at phone width", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const buckets: ChartBucket[] = [
      { key: "2026-08", label: "August 2026", short: "Aug", total: 3000, values: { Groceries: 3000 } },
      { key: "2026-09", label: "September 2026", short: "Sep", total: 5000, values: { Groceries: 5000 } },
      { key: "2026-10", label: "October 2026", short: "Oct", total: 2000, values: { Groceries: 2000 } },
    ];
    const { container } = render(
      <SpendChart buckets={buckets} selected={null} onSelect={() => {}} />,
    );
    const texts = svgTexts(container);
    expect(texts).toContain("£5k");
    expect(texts).toContain("£2.5k");
    expect(texts).not.toContain("£5,000");
  });
});

describe("SpendChart without a measured width (desktop path)", () => {
  it("keeps every bucket and the full tick labels", () => {
    const buckets: ChartBucket[] = [
      { key: "2026-08", label: "August 2026", short: "Aug", total: 20000, values: { Groceries: 20000 } },
      { key: "2026-09", label: "September 2026", short: "Sep", total: 5000, values: { Groceries: 5000 } },
      { key: "2026-10", label: "October 2026", short: "Oct", total: 8000, values: { Groceries: 8000 } },
    ];
    const { container } = render(
      <SpendChart buckets={buckets} selected={null} onSelect={() => {}} />,
    );
    expect(svgTexts(container)).toContain("£20,000");
    expect(container.querySelectorAll("title")).toHaveLength(3);
  });
});

describe("Income vs spending compact nets", () => {
  it("carries a compact signed net per month alongside the full figure", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      flowMonthly: {
        months: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
        income: { household: [0, 0, 0, 0, 18775.2, 311.82] },
        spend: { household: [2268.51, 0, 0, 0, 3999.71, 2102.39] },
      },
    } as DataSnapshot);
    const { container } = render(
      <PersonProvider>
        <IncomeSpendingCard person="household" />
      </PersonProvider>,
    );
    // Full figures remain in the DOM (desktop + title/sr text)…
    expect(container.textContent).toContain("−£2,268.51");
    expect(container.textContent).toContain("+£14,775.49");
    // …and the compact forms the phone columns actually show.
    expect(container.textContent).toContain("−£2.3k");
    expect(container.textContent).toContain("+£14.8k");
    // The headline gap keeps its full signed figure in one nowrap span.
    const headline = screen.getByText(/In £311\.82/);
    expect(headline.textContent).toContain("In £311.82 · Out £2,102.39 · Gap −£1,790.57");
  });
});
