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
 * Home is bands of two independent stacks ordered by value: band 1
 * pairs the hero with Biggest changes (left) against Available with
 * the forecast beneath it (right); the trend chart is a full-width
 * divider; band 3 pairs Coming up with Small spends (left) against
 * Coach over Money in (right); the Moved aside strip is last. Within
 * a band each column is a stack of natural-height cards, so no card
 * shares a row with a taller row-mate and a band's columns can
 * differ only at the band's own bottom. On mobile the band/stack
 * wrappers collapse (display: contents) and each card's order class
 * carries the single-column value order pinned below. Plus the
 * shared chart's rendering fixes: full £ axis labels, a faint
 * active-bucket tint, a bold current-period label.
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

/** Class tokens of an element (className is a plain string on the
 *  HTML elements these helpers walk). */
const tokens = (el: Element | null): string[] =>
  typeof el?.className === "string" ? el.className.split(/\s+/).filter(Boolean) : [];

/** The order-N value a card carries (walking up from a text node to
 *  the card element that carries the class). */
const orderOf = (el: Element): number | null => {
  let node: Element | null = el;
  while (node) {
    const hit = tokens(node).find((t) => /^order-\d+$/.test(t));
    if (hit) return Number(hit.slice("order-".length));
    node = node.parentElement;
  }
  return null;
};

/** The stack wrapper a card belongs to (the lg:flex-col ancestor),
 *  or null when the card is a direct child of the page column. */
const stackOf = (el: Element): HTMLElement | null => {
  let node = el.parentElement;
  while (node) {
    if (tokens(node).includes("lg:flex-col")) return node as HTMLElement;
    node = node.parentElement;
  }
  return null;
};

/** The page column itself: the flex flex-col ancestor of a card. */
const pageOf = (el: Element): HTMLElement | null => {
  let node: Element | null = el;
  while (node) {
    if (tokens(node).includes("flex") && tokens(node).includes("flex-col")) {
      return node as HTMLElement;
    }
    node = node.parentElement;
  }
  return null;
};

const availableButton = () =>
  screen.getByRole("button", {
    name: "Available balance, show breakdown by account",
  });

describe("Home banded stacks", () => {
  it("carries the mobile single-column value order in the cards' order classes", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    // On mobile the wrappers collapse and the outer column lays the
    // cards out by these order values, so they must run 1..10 in
    // exactly the value order.
    const expected: [Element, number][] = [
      [screen.getByText(/Spent in/), 1],
      [availableButton(), 2],
      [screen.getByText(/Rest of/), 3],
      [screen.getByText(/Spending trend/), 4],
      [screen.getByText(/Coming up/), 5],
      [screen.getByText(/Biggest changes/), 6],
      [screen.getByText("Coach"), 7],
      [screen.getByText(/Money in/), 8],
      [screen.getByText(/Small spends/), 9],
      [screen.getByText("Moved aside"), 10],
    ];
    for (const [el, n] of expected) {
      expect(orderOf(el), `order for #${n}`).toBe(n);
    }
    // The page is one flex column, not a row grid: no card is placed
    // by grid row/column classes any more.
    const page = pageOf(screen.getByText(/Spent in/));
    expect(page).toBeTruthy();
    expect(page!.className).not.toContain("grid");
  });

  it("band 1: hero + Biggest changes in the left stack, Available + forecast in the right", () => {
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const heroStack = stackOf(screen.getByText(/Spent in/));
    expect(heroStack).toBeTruthy();
    expect(heroStack!.textContent).toContain("Biggest changes");
    expect(heroStack!.textContent).not.toContain("Rest of");
    const moneyStack = stackOf(availableButton());
    expect(moneyStack).toBeTruthy();
    expect(moneyStack).not.toBe(heroStack);
    expect(moneyStack!.textContent).toContain("Rest of");
    expect(moneyStack!.textContent).not.toContain("Biggest changes");
    // Both stacks belong to one band (a contents wrapper that
    // becomes a flex row on desktop).
    const band = heroStack!.parentElement;
    expect(band).toBe(moneyStack!.parentElement);
    expect(tokens(band).includes("contents")).toBe(true);
    expect(tokens(band).includes("lg:flex")).toBe(true);
    expect(tokens(band).includes("lg:flex-col")).toBe(false);
    // The band wrapper's own order sequences the desktop bands
    // around the chart (4) and the strip (10): band 1 is order 1.
    expect(orderOf(band!)).toBe(1);
    // No grid placement classes survive anywhere on Home.
    expect(container.innerHTML).not.toMatch(/lg:(row|col)-start/);
  });

  it("the trend chart is a full-width band of its own, not inside any stack", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const trend = screen.getByText("Spending trend").closest("section")!;
    expect(stackOf(trend)).toBeNull();
    expect(trend.parentElement).toBe(pageOf(trend));
  });

  it("band 3: Coming up + Small spends left, Coach + Money in right", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const left = stackOf(screen.getByText(/Coming up/));
    expect(left).toBeTruthy();
    expect(left!.textContent).toContain("Small spends");
    expect(left!.textContent).not.toContain("Money in");
    const right = stackOf(screen.getByText("Coach"));
    expect(right).toBeTruthy();
    expect(right).not.toBe(left);
    expect(right!.textContent).toContain("Money in");
    expect(right!.textContent).not.toContain("Coming up");
    expect(left!.parentElement).toBe(right!.parentElement);
    // Band 3's wrapper order (5) sits between the chart (4) and
    // the strip (10) in the desktop column.
    expect(orderOf(left!.parentElement!)).toBe(5);
  });

  it("keeps the forecast in band 1's right stack in both forecast states", () => {
    // Default fixture: statements run to 28 Oct, so the forecast is
    // in its live (tall) form.
    const { unmount } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const live = screen.getByText(/On course to end/);
    expect(stackOf(live)).toBe(stackOf(availableButton()));
    unmount();
    // Data runs to month end (a 31 Oct transaction, statements to
    // the 31st): the forecast takes its short completed form, in
    // the same stack.
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      txns: [
        ...SAMPLE_SNAPSHOT.txns,
        {
          id: "e31",
          date: "2026-10-31",
          day: 31,
          monthKey: "2026-10",
          merchant: "TfL",
          category: "Transport",
          amount: 5,
          owner: "zonito",
          account: "Revolut Main · Zonito",
          kind: "spend",
        } as const,
      ],
      accounts: SAMPLE_SNAPSHOT.accounts.map((a) => ({
        ...a,
        last: "31 Oct",
        lastDate: "2026-10-31",
      })),
    });
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const done = screen.getByText(/is complete in your statements/);
    expect(stackOf(done)).toBe(stackOf(availableButton()));
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
    // The strip closes the page: a direct child of the page column,
    // inside no stack, carrying the last order value.
    expect(strip.parentElement).toBe(pageOf(strip));
    expect(stackOf(strip)).toBeNull();
    expect(orderOf(strip)).toBe(10);
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
