import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import {
  asidePace,
  coachLines,
  coachNote,
  hydrateData,
  typicalAside,
  type AppSettings,
  type DataSnapshot,
  type Txn,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";
import { openStore } from "@/lib/ingest/store";
import { recomputeAggregates } from "@/lib/ingest/ingest";
import { buildSnapshot } from "@/lib/snapshot.server";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index } = await import("@/routes/index");

/**
 * Coach guidance. Fixture facts (SAMPLE_SNAPSHOT, October 2026,
 * household view): Available £10,306.75; moved aside this month
 * £1,050 (500 + 400 + 150 across three rows); the aside series is
 * flat £1,050 a month May–Oct, so September's pace is £1,050 and a
 * typical month is £1,050; Holidays spend £1,555.40 against a usual
 * £160 (diff £1,395.40); Groceries £561.40; Eating out £300.00
 * against a usual £230; November regulars total £582.95; small
 * spends (under £10) total £41.33 across 5 spends (Pret ×3 at
 * £7.45, iCloud+ £8.99, Disney+ £9.99) — material on its own, but
 * on the plain fixture it ranks below the two bigger levers.
 */

const withSettings = (settings: Partial<AppSettings>): DataSnapshot => ({
  ...SAMPLE_SNAPSHOT,
  settings: {
    availableFloorMinor: null,
    overallMonthlyBudgetMinor: null,
    categoryBudgets: {},
    jevEnabled: true,
    jevLastOutcome: null,
    ...settings,
  },
});

const withAsideHousehold = (totals: number[]): DataSnapshot => ({
  ...SAMPLE_SNAPSHOT,
  asideMonthly: {
    months: [...SAMPLE_SNAPSHOT.asideMonthly.months],
    totals: { ...SAMPLE_SNAPSHOT.asideMonthly.totals, household: totals },
  },
});

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Coach floor lines", () => {
  it("below the floor: gap and the path at last month's pace (1 month)", () => {
    hydrateData(withSettings({ availableFloorMinor: 1100000 })); // £11,000
    const lines = coachLines("household");
    expect(lines[0]).toBe(
      "£693 below your £11,000 floor. You moved £1,050 aside in September; at that pace the floor is reached in about 1 month.",
    );
  });

  it("below the floor: a bigger gap reads as about N months", () => {
    hydrateData(withSettings({ availableFloorMinor: 1250000 })); // £12,500
    const lines = coachLines("household");
    expect(lines[0]).toBe(
      "£2,193 below your £12,500 floor. You moved £1,050 aside in September; at that pace the floor is reached in about 3 months.",
    );
  });

  it("below the floor with nothing moved aside last month: no date is promised", () => {
    hydrateData({
      ...withSettings({ availableFloorMinor: 1100000 }),
      asideMonthly: withAsideHousehold([1050, 1050, 1050, 1050, 0, 1050])
        .asideMonthly,
    });
    const lines = coachLines("household");
    expect(lines[0]).toBe(
      "£693 below your £11,000 floor. Nothing was moved aside in September.",
    );
    expect(lines[0]).not.toContain("reached");
  });

  it("at or above the floor: a short headroom line", () => {
    hydrateData(withSettings({ availableFloorMinor: 900000 })); // £9,000
    const lines = coachLines("household");
    expect(lines[0]).toBe("£1,307 above your floor.");
  });

  it("pace helpers read the aside series: previous month and the 6-month median", () => {
    hydrateData(withAsideHousehold([600, 600, 600, 600, 600, 1050]));
    expect(asidePace("household")).toEqual({ monthKey: "2026-09", total: 600 });
    // Previous 6 months are Apr (absent, 0) and May–Sep (600 each):
    // median of [0, 600, 600, 600, 600, 600] is 600.
    expect(typicalAside("household")).toBe(600);
  });
});

describe("Coach levers", () => {
  it("over-budget lever: exact over figure, stated both ways", () => {
    hydrateData(withSettings({ categoryBudgets: { Groceries: 40000 } })); // £400 vs £561.40
    const lines = coachLines("household");
    expect(lines).toContain(
      "Groceries is £161 over its budget; back to budget adds £161.",
    );
  });

  it("levers are capped at two, ranked by £ impact", () => {
    hydrateData(
      withSettings({
        categoryBudgets: { Groceries: 40000, "Eating out": 20000 },
      }),
    );
    // Candidates: Holidays above usual £1,395.40, Groceries over
    // budget £161.40, Eating out over budget £100 — the smallest drops.
    const lines = coachLines("household");
    expect(lines).toContain("Holidays ran £1,395 above a usual month.");
    expect(lines).toContain(
      "Groceries is £161 over its budget; back to budget adds £161.",
    );
    expect(lines.join(" ")).not.toContain("Eating out is");
  });

  it("above-a-usual-month lever uses the typical baseline with its materiality bar", () => {
    // Default fixture: Holidays is the only category ≥£50 and ≥20%
    // over its usual month (Eating out is £70 over but that is the
    // only other riser — £70 ≥ £50 and ≥ 20% of £230=£46, so it
    // qualifies too and ranks second).
    const lines = coachLines("household");
    expect(lines[0]).toBe("Holidays ran £1,395 above a usual month.");
    expect(lines).toContain("Eating out ran £70 above a usual month.");
    // Groceries is £21.40 over a usual £540: under the £50 bar.
    expect(lines.join(" ")).not.toContain("Groceries ran");
  });

  it("small-spends lever: the under-£10 pile as one figure", () => {
    const extra: Txn[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      id: `small-${i}`,
      date: "2026-10-15",
      day: 15,
      monthKey: "2026-10",
      merchant: "Corner Shop",
      category: "Groceries",
      amount: 8,
      owner: "zonito",
      account: "Revolut Main · Zonito",
      kind: "spend",
    }));
    hydrateData({ ...SAMPLE_SNAPSHOT, txns: [...SAMPLE_TXNS, ...extra] });
    const lines = coachLines("household");
    // The fixture's own £41.33 across 5 small spends (Pret ×3,
    // iCloud+, Disney+) + 7 × £8 = £97.33 across 12 spends.
    expect(lines).toContain(
      "Spends under £10 added up to £97.33 this month across 12 spends.",
    );
  });

  it("savings-pace lever: ahead of a typical month, and the plain aside fact steps aside", () => {
    hydrateData(withAsideHousehold([600, 600, 600, 600, 600, 1050]));
    const lines = coachLines("household");
    expect(lines).toContain(
      "You moved £1,050 aside this month, £450 more than a typical month.",
    );
    expect(lines.join(" ")).not.toContain(
      "was moved aside into savings and investments",
    );
  });
});

describe("Coach forward check", () => {
  it("relates next month's known regulars to Available", () => {
    const lines = coachLines("household");
    expect(lines).toContain(
      "£583 of November regulars already known against £10,306.75 available.",
    );
  });

  it("no known regulars, no forward line", () => {
    hydrateData({ ...SAMPLE_SNAPSHOT, upcoming: [] });
    const lines = coachLines("household");
    expect(lines.join(" ")).not.toContain("regulars already known");
  });
});

describe("Coach with nothing configured", () => {
  it("keeps the pre-existing fact lines and never mentions floors or budgets", () => {
    const note = coachNote("household");
    expect(note).toContain(
      "The big one-off is Kingsley Napley LLP at £1,850 — tagged one-off, so it won't skew your usual month.",
    );
    expect(note).toContain(
      "£1,050 was moved aside into savings and investments.",
    );
    expect(note.toLowerCase()).not.toContain("floor");
    expect(note.toLowerCase()).not.toContain("budget");
    // The biggest-change fact for Holidays is stated once, in its
    // lever form — not repeated as a second fact line.
    expect(note.match(/Holidays/g)).toHaveLength(1);
  });

  it("the Home Coach card renders the same lines", () => {
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    // The Coach card is the link whose body is the note itself (the
    // nav's Coach tab carries no note text).
    const card = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("The big one-off"),
    );
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain(
      "£1,050 was moved aside into savings and investments.",
    );
    expect(card!.textContent?.toLowerCase()).not.toContain("floor");
    expect(card!.textContent?.toLowerCase()).not.toContain("budget");
  });
});

describe("snapshot builder: aside series", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("sums aside_minor per person-month; household falls back to the people's rows, then stored rows win", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-coach-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, ?, 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, ?, NULL)`,
    );
    // Zonito moved £200 aside in September, £50 in October; Nikhila
    // £300 in September. One spend row so October has spending too.
    insert.run(
      "a1",
      "zonito",
      "2026-09-10",
      "2026-09",
      "Revolut Savings",
      "Revolut Savings",
      -20000,
      "aside",
    );
    insert.run(
      "a2",
      "zonito",
      "2026-10-10",
      "2026-10",
      "Revolut Savings",
      "Revolut Savings",
      -5000,
      "aside",
    );
    insert.run(
      "a3",
      "nikhila",
      "2026-09-12",
      "2026-09",
      "Vanguard ISA",
      "Vanguard ISA",
      -30000,
      "aside",
    );
    insert.run(
      "s1",
      "zonito",
      "2026-10-05",
      "2026-10",
      "Ocado",
      "Ocado",
      -4250,
      "spend",
    );
    recomputeAggregates(db, "zonito");
    recomputeAggregates(db, "nikhila");
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const fallback = buildSnapshot();
    expect(fallback.asideMonthly.months).toEqual(["2026-09", "2026-10"]);
    expect(fallback.asideMonthly.totals.zonito).toEqual([200, 50]);
    expect(fallback.asideMonthly.totals.nikhila).toEqual([300, 0]);
    // No stored household rows yet: the two people's rows summed.
    expect(fallback.asideMonthly.totals.household).toEqual([500, 50]);

    // Once stored household rows exist they win outright — a stored
    // figure that differs from the people's sum is used as stored,
    // never summed with it (which would double-count).
    const db2 = openStore(dir);
    recomputeAggregates(db2, "household");
    db2
      .prepare(
        "UPDATE month_aggregates SET aside_minor = aside_minor + 10000 WHERE person = 'household' AND year_month = '2026-09'",
      )
      .run();
    db2.close();
    const stored = buildSnapshot();
    expect(stored.asideMonthly.totals.household).toEqual([600, 50]);
  });
});
