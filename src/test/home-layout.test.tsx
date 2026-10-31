import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { hydrateData } from "@/lib/data";
import { SpendChart } from "@/components/spend-chart";
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
const { Index } = await import("@/routes/index");

/**
 * Home is a defined grid ordered by value (hero + Available, trend,
 * Coming up + Biggest changes/Coach, Money in + Small spends, Moved
 * aside strip), and the shared chart's rendering fixes: full £ axis
 * labels, a faint active-bucket tint, a bold current-period label.
 * DOM order in these tests IS the mobile single-column order.
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

const ORDER = [
  "Spent in",
  "Available",
  "Spending trend",
  "Coming up",
  "Biggest changes",
  "Coach",
  "Money in",
  "Small spends",
  "Moved aside",
];

describe("Home value-ordered grid", () => {
  it("renders the sections in the value order (which is also the mobile order)", () => {
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const text = container.textContent ?? "";
    let last = -1;
    for (const marker of ORDER) {
      const at = text.indexOf(marker);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
  });

  it("places hero and Available in row 1, the changes column in row 3", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const hero = screen.getByText(/Spent in/);
    expect(hero.closest(".hero-panel")!.className).toContain("lg:row-start-1");
    expect(hero.closest(".hero-panel")!.className).toContain("lg:col-start-1");
    const available = screen.getByRole("button", {
      name: "Available balance, show breakdown by account",
    });
    expect(available.closest("section")!.className).toContain("lg:col-start-2");
    expect(available.closest("section")!.className).toContain("lg:row-start-1");
    // Biggest changes and Coach share the row-3 right column; Coming
    // up is not in it.
    let cell: HTMLElement | null = screen.getByText("Biggest changes") as HTMLElement;
    while (cell && !(cell.className ?? "").includes("lg:row-start-3")) {
      cell = cell.parentElement;
    }
    expect(cell).toBeTruthy();
    expect(cell!.textContent).toContain("Coach");
    expect(cell!.textContent).not.toContain("Coming up");
  });

  it("Moved aside is a slim one-line strip, not a full card", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const caption = screen.getByText("Savings & investments, not spending");
    const strip = caption.closest("section")!;
    expect(strip.className).toContain("flex");
    expect(strip.className).toContain("items-center");
    expect(strip.className).toContain("lg:col-span-2");
    // One line, in order: label, amount, what it is.
    const text = strip.textContent ?? "";
    const labelAt = text.indexOf("Moved aside");
    const amountAt = text.search(/£[\d,]+/);
    const captionAt = text.indexOf("Savings & investments");
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(amountAt).toBeGreaterThan(labelAt);
    expect(captionAt).toBeGreaterThan(amountAt);
  });
});

describe("SpendChart rendering fixes", () => {
  const buckets: ChartBucket[] = [
    { key: "2026-08", label: "August 2026", short: "Aug", total: 20000, values: { Groceries: 20000 } },
    { key: "2026-09", label: "September 2026", short: "Sep", total: 5000, values: { Groceries: 5000 } },
    { key: "2026-10", label: "October 2026", short: "Oct", total: 8000, values: { Groceries: 8000 } },
  ];

  it("the £20,000 axis label is fully present with room at the left edge", () => {
    const { container } = render(
      <SpendChart buckets={buckets} selected={null} onSelect={() => {}} />,
    );
    const texts = [...container.querySelectorAll("text")];
    const top = texts.find((t) => t.textContent === "£20,000");
    expect(top).toBeTruthy();
    // textAnchor=end at x: the label's full width (≈7 glyphs at 11px)
    // must fit between the viewBox edge and x — the old 42 clipped it.
    expect(Number(top!.getAttribute("x"))).toBeGreaterThanOrEqual(50);
  });

  it("the active-bucket highlight is a faint tint and the current period label is bold", () => {
    const { container } = render(
      <SpendChart buckets={buckets} selected={null} onSelect={() => {}} />,
    );
    const band = [...container.querySelectorAll("rect")].find(
      (r) => r.getAttribute("fill") === "var(--accent)",
    );
    expect(band).toBeTruthy();
    expect(Number(band!.getAttribute("opacity"))).toBeLessThanOrEqual(0.15);
    const texts = [...container.querySelectorAll("text")];
    const current = texts.find((t) => t.textContent === "Oct");
    expect(current!.getAttribute("font-weight")).toBe("700");
    const older = texts.find((t) => t.textContent === "Aug");
    expect(older!.getAttribute("font-weight")).toBeNull();
  });
});
