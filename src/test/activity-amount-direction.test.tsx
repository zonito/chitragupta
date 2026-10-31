import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
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

// Imported after the router mock is registered (for the Home check).
const { Index } = await import("@/routes/index");

/**
 * Credit/debit amounts in Activity (list rows and the detail sheet):
 * money in renders as a green "+£X" (amount-in), money out as a red
 * "−£X" (amount-out) — the styles.css classes over the AA-verified
 * --good / --destructive tokens. Direction is the row's own sign:
 * income, transfer-in legs and withdrawals landing back are credits;
 * spends, transfer-out legs and money moved aside are debits. Other
 * screens keep their existing amount styling untouched.
 */

const mk = (over: Partial<Txn>): Txn => ({
  id: "x",
  date: "2026-10-20",
  day: 20,
  monthKey: "2026-10",
  merchant: "M",
  category: "Groceries",
  amount: 10,
  owner: "zonito",
  account: "Revolut Main · Zonito",
  accountId: "Main",
  kind: "spend",
  ...over,
});

const ROWS: Txn[] = [
  mk({ id: "inc", merchant: "ACME PAYROLL", category: "One-off", kind: "income", incoming: true, amount: 3000, day: 28, date: "2026-10-28" }),
  mk({ id: "spend", merchant: "Corner Shop", kind: "spend", amount: 42.5, day: 27, date: "2026-10-27" }),
  mk({ id: "tin", merchant: "Nikhila → Zonito", category: "Transfer", kind: "transfer", incoming: true, amount: 250, day: 26, date: "2026-10-26" }),
  mk({ id: "tout", merchant: "Zonito → Nikhila", category: "Transfer", kind: "transfer", amount: 600, day: 25, date: "2026-10-25" }),
  mk({ id: "aout", merchant: "Trading 212", category: "Moved aside", kind: "aside", amount: 900, day: 24, date: "2026-10-24" }),
  mk({ id: "ain", merchant: "ISA Withdrawal", category: "Moved aside", kind: "aside", incoming: true, amount: 120, day: 23, date: "2026-10-23" }),
];

function hydrateRows() {
  const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
  snap.txns = ROWS;
  hydrateData(snap);
}

function renderActivity() {
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

/** The amount element inside a merchant's list row. */
function rowAmount(merchant: string): HTMLElement {
  const row = screen.getByText(merchant).closest("button")!;
  const hit = [...row.querySelectorAll("span")].find((s) =>
    /^[+−]£/.test(s.textContent ?? ""),
  );
  expect(hit, `amount for ${merchant}`).toBeTruthy();
  return hit!;
}

beforeEach(() => {
  window.history.pushState({}, "", "/activity");
  hydrateRows();
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity credit/debit amounts", () => {
  it("an income row renders a green credit, a spend row a red debit", () => {
    renderActivity();
    const income = rowAmount("ACME PAYROLL");
    expect(income.textContent).toBe("+£3,000.00");
    expect(income.classList.contains("amount-in")).toBe(true);
    expect(income.classList.contains("amount-out")).toBe(false);

    const spend = rowAmount("Corner Shop");
    expect(spend.textContent).toBe("−£42.50");
    expect(spend.classList.contains("amount-out")).toBe(true);
    expect(spend.classList.contains("amount-in")).toBe(false);
  });

  it("transfer legs and moved-aside rows follow their own sign", () => {
    renderActivity();
    expect(rowAmount("Nikhila → Zonito").textContent).toBe("+£250.00");
    expect(rowAmount("Nikhila → Zonito").classList.contains("amount-in")).toBe(true);
    expect(rowAmount("Zonito → Nikhila").textContent).toBe("−£600.00");
    expect(rowAmount("Zonito → Nikhila").classList.contains("amount-out")).toBe(true);
    expect(rowAmount("Trading 212").textContent).toBe("−£900.00");
    expect(rowAmount("Trading 212").classList.contains("amount-out")).toBe(true);
    expect(rowAmount("ISA Withdrawal").textContent).toBe("+£120.00");
    expect(rowAmount("ISA Withdrawal").classList.contains("amount-in")).toBe(true);
  });

  it("the detail sheet headline matches the row's direction", async () => {
    renderActivity();
    fireEvent.click(screen.getByText("ACME PAYROLL").closest("button")!);
    const dialog = await screen.findByRole("dialog");
    const headline = within(dialog).getByText("+£3,000.00");
    expect(headline.classList.contains("amount-in")).toBe(true);

    fireEvent.click(screen.getByText("Corner Shop").closest("button")!);
    const spendHeadline = within(dialog).getByText("−£42.50");
    expect(spendHeadline.classList.contains("amount-out")).toBe(true);
  });

  it("other screens keep their amount styling: Home uses no direction classes", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    // No element on Home carries the Activity direction classes, so
    // none of its amounts took the credit/debit treatment. (Home's
    // Biggest-changes deltas have always used their own +/- signs —
    // those are change figures, not transaction amounts.)
    expect(container.querySelectorAll(".amount-in, .amount-out")).toHaveLength(0);
  });
});
