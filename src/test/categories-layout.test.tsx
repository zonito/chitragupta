import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { Categories } from "@/routes/categories";
import { byCategory, hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Categories screen layout (Task 4):
 * - The monthly per-category list is the screen's lead content again:
 *   it renders ABOVE the "Spending over time" chart section (the chart
 *   landed on top of it in f7b1ddb and pushed the list down).
 * - The category rows keep the pre-chart structure, byte-for-byte the
 *   markup the rows had before the chart work (verified against
 *   9d33085's categories.tsx — the row element never actually changed;
 *   these assertions pin its key class hooks so it cannot drift).
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  vi.unstubAllGlobals();
});

const renderCategories = () =>
  render(
    <PersonProvider>
      <Categories />
    </PersonProvider>,
  );

/** The row <button> for a category: the only button whose text leads
 * with the category name (chart legend buttons read "Name · £total"). */
function categoryRow(name: string): HTMLElement {
  const el = screen
    .getAllByRole("button")
    .find(
      (b) =>
        b.classList.contains("panel-enter") &&
        b.textContent?.includes(name),
    );
  if (!el) throw new Error(`no category row for ${name}`);
  return el;
}

describe("Categories screen layout", () => {
  it("lists the month's categories above the Spending over time chart", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    renderCategories();
    const cats = byCategory("household");
    expect(cats.length).toBeGreaterThan(0);
    const firstRow = categoryRow(cats[0]!.category);
    const chartHeading = screen.getByText("Spending over time");
    // DOCUMENT_POSITION_FOLLOWING on the row means the chart heading
    // comes after the row in document order.
    expect(
      firstRow.compareDocumentPosition(chartHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Every category row precedes the chart section, not just the first.
    const lastRow = categoryRow(cats[cats.length - 1]!.category);
    expect(
      lastRow.compareDocumentPosition(chartHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("category rows carry the restored pre-chart structure and hover classes", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    renderCategories();
    const row = categoryRow("Groceries");
    expect(row.tagName).toBe("BUTTON");
    for (const hook of [
      "panel-enter",
      "block",
      "h-auto",
      "w-full",
      "whitespace-normal",
      "rounded-none",
      "p-0",
      "text-left",
      "font-normal",
      "hover:bg-transparent",
      "hover:text-foreground",
    ]) {
      expect(row.classList.contains(hook), `row class ${hook}`).toBe(true);
    }
    // Name + amount line: the row's first child, icon slot + name on
    // the left, the .num.amount figure on the right.
    const line = row.firstElementChild as HTMLElement;
    expect(line.classList.contains("mb-1.5")).toBe(true);
    expect(line.classList.contains("flex")).toBe(true);
    expect(line.classList.contains("justify-between")).toBe(true);
    expect(line.classList.contains("text-body")).toBe(true);
    const amount = row.querySelector(".num.amount");
    expect(amount).not.toBeNull();
    expect(amount!.textContent).toMatch(/£/);
    // The relative bar: an h-2 muted track with the animated bar in
    // the category colour inside it.
    const track = row.querySelector(".h-2.rounded-lg.bg-muted");
    expect(track).not.toBeNull();
    expect(track!.querySelector(".data-bar")).not.toBeNull();
    // The list container keeps its pre-chart grid contract.
    const list = row.parentElement as HTMLElement;
    expect(list.classList.contains("space-y-5")).toBe(true);
    expect(list.classList.contains("lg:grid-cols-2")).toBe(true);
  });
});
