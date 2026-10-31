import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PersonProvider, ThemeProvider, usePerson } from "@/components/shell";
import {
  byCategory,
  gbp,
  hydrateData,
  spendTotal,
  type AppSettings,
  type DataSnapshot,
} from "@/lib/data";
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
const { Categories } = await import("@/routes/categories");
const { Settings } = await import("@/routes/settings");

/**
 * Floors & budgets, UI side. Fixture facts (SAMPLE_SNAPSHOT, October
 * 2026): household Available is £10,306.75, Zonito's own is £6,592.10
 * (Joint excluded), household spend and per-category totals come from
 * the data helpers so the expectations track the fixture exactly.
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

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  vi.unstubAllGlobals();
});

const renderHome = () =>
  render(
    <PersonProvider>
      <Index />
    </PersonProvider>,
  );

describe("Available floor signal", () => {
  it("below the floor: danger amount and the factual line, on the card and in the breakdown", () => {
    hydrateData(withSettings({ availableFloorMinor: 1100000 })); // £11,000 > £10,306.75
    const { container } = renderHome();
    expect(screen.getByText("Below your £11,000 floor")).toBeTruthy();
    const card = screen.getByRole("button", {
      name: "Available balance, show breakdown by account",
    });
    expect(
      card.querySelector(".text-title")!.classList.contains("text-destructive"),
    ).toBe(true);
    expect(screen.getByText(/Across 6 accounts/)).toBeTruthy();
    void container;

    fireEvent.click(card);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Below your £11,000 floor");
    expect(dialog.textContent).toContain("Total available");
  });

  it("at or above the floor: a muted Floor line and no danger styling", () => {
    hydrateData(withSettings({ availableFloorMinor: 1000000 })); // £10,000 < £10,306.75
    renderHome();
    expect(screen.getByText("Floor £10,000")).toBeTruthy();
    expect(screen.queryByText(/Below your/)).toBeNull();
    const card = screen.getByRole("button", {
      name: "Available balance, show breakdown by account",
    });
    expect(
      card.querySelector(".text-title")!.classList.contains("text-destructive"),
    ).toBe(false);
  });

  it("exactly at the floor counts as met, and the floor is quoted exactly", () => {
    hydrateData(withSettings({ availableFloorMinor: 1030675 })); // £10,306.75
    renderHome();
    expect(screen.getByText("Floor £10,306.75")).toBeTruthy();
    expect(screen.queryByText(/Below your/)).toBeNull();
  });

  it("judges each person view by its own headline (Joint stays out)", () => {
    hydrateData(withSettings({ availableFloorMinor: 700000 })); // £7,000
    function Harness() {
      const { setPerson } = usePerson();
      return (
        <>
          <button onClick={() => setPerson("zonito")}>view zonito</button>
          <Index />
        </>
      );
    }
    render(
      <PersonProvider>
        <Harness />
      </PersonProvider>,
    );
    // Household £10,306.75 is above £7,000: no warning.
    expect(screen.getByText("Floor £7,000")).toBeTruthy();
    expect(screen.queryByText(/Below your/)).toBeNull();
    fireEvent.click(screen.getByText("view zonito"));
    // Zonito's own £6,592.10 is below £7,000: the signal flips.
    expect(screen.getByText("Below your £7,000 floor")).toBeTruthy();
  });

  it("no floor set: the card is exactly as before", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    renderHome();
    expect(screen.queryByText(/floor/i)).toBeNull();
  });
});

describe("Overall monthly budget on the hero", () => {
  it("under budget: a slim progress line with spent-of-budget", () => {
    hydrateData(withSettings({ overallMonthlyBudgetMinor: 600000 }));
    const { container } = renderHome();
    const hero = container.querySelector(".hero-panel")!;
    const spent = gbp(spendTotal("household"), false);
    expect(hero.textContent).toContain(`${spent} of £6,000 budget`);
    expect(hero.textContent).not.toContain("over budget");
    // Two summary bars (month + typical) plus the budget track.
    expect(hero.querySelectorAll(".hero-track")).toHaveLength(3);
  });

  it("over budget: the over figure is danger-coloured, on the hero scale", () => {
    hydrateData(withSettings({ overallMonthlyBudgetMinor: 500000 }));
    const { container } = renderHome();
    const hero = container.querySelector(".hero-panel")!;
    const over = gbp(spendTotal("household") - 5000, false);
    expect(hero.textContent).toContain(`${over} over budget`);
    const danger = [...hero.querySelectorAll("span")].find(
      (s) => s.textContent === `${over} over budget`,
    );
    expect(danger).toBeTruthy();
    expect(danger!.classList.contains("hero-danger")).toBe(true);
  });

  it("no budget set: the hero carries no budget line", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    const { container } = renderHome();
    const hero = container.querySelector(".hero-panel")!;
    expect(hero.textContent).not.toContain("budget");
    expect(hero.querySelectorAll(".hero-track")).toHaveLength(2);
  });
});

/** The row <button> for a category (mirrors categories-layout.test). */
function categoryRow(name: string): HTMLElement {
  const el = screen
    .getAllByRole("button")
    .find(
      (b) => b.classList.contains("panel-enter") && b.textContent?.includes(name),
    );
  if (!el) throw new Error(`no category row for ${name}`);
  return el;
}

describe("Category budgets in the monthly list", () => {
  const groceries = () =>
    byCategory("household").find((c) => c.category === "Groceries")!.amount;

  it("over budget: danger amount, budget bar and the over figure inside the pinned row", () => {
    hydrateData(withSettings({ categoryBudgets: { Groceries: 50000 } })); // £500
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    const row = categoryRow("Groceries");
    // The pinned structure survives: name/amount line first, h-2 bar.
    expect(row.firstElementChild!.classList.contains("mb-1.5")).toBe(true);
    expect(row.querySelector(".h-2.rounded-lg.bg-muted")).not.toBeNull();
    const amount = row.querySelector(".num.amount")!;
    expect(amount.classList.contains("text-destructive")).toBe(true);
    expect(row.textContent).toContain("Budget £500");
    expect(row.textContent).toContain(`${gbp(groceries() - 500, false)} over`);
    // The slim budget bar rides under the relative bar.
    expect(row.querySelector(".h-1.rounded-lg.bg-muted")).not.toBeNull();
  });

  it("under budget: remaining figure, no danger styling", () => {
    hydrateData(withSettings({ categoryBudgets: { Groceries: 60000 } })); // £600
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    const row = categoryRow("Groceries");
    expect(row.textContent).toContain("Budget £600");
    expect(row.textContent).toContain(`${gbp(600 - groceries(), false)} left`);
    expect(
      row.querySelector(".num.amount")!.classList.contains("text-destructive"),
    ).toBe(false);
  });

  it("unbudgeted rows and the no-budgets case render exactly as before", () => {
    hydrateData(withSettings({ categoryBudgets: { Groceries: 50000 } }));
    const first = render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    expect(categoryRow("Transport").textContent).not.toContain("Budget");
    first.unmount();

    hydrateData(SAMPLE_SNAPSHOT);
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    expect(screen.queryByText(/Budget £/)).toBeNull();
  });
});

describe("Settings: Floors & budgets form", () => {
  it("lists a field per spend category (never a system label) and seeds from the snapshot", () => {
    hydrateData(
      withSettings({
        availableFloorMinor: 1000000,
        categoryBudgets: { Groceries: 50000 },
      }),
    );
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    expect(screen.getByText("Floors & budgets")).toBeTruthy();
    expect(
      (screen.getByLabelText("Available floor, in pounds") as HTMLInputElement)
        .value,
    ).toBe("10000");
    expect(
      (screen.getByLabelText(
        "Overall monthly budget, in pounds",
      ) as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText(
        "Monthly budget for Groceries, in pounds",
      ) as HTMLInputElement).value,
    ).toBe("500");
    for (const name of ["Transport", "School", "Home", "Subscriptions", "Holidays", "Shopping", "One-off", "Eating out"]) {
      expect(
        screen.getByLabelText(`Monthly budget for ${name}, in pounds`),
      ).toBeTruthy();
    }
    for (const label of ["Moved aside", "Transfer", "Interest", "Fees"]) {
      expect(
        screen.queryByLabelText(`Monthly budget for ${label}, in pounds`),
      ).toBeNull();
    }
  });

  it("saves the whole form through PUT /api/settings and confirms", async () => {
    hydrateData(
      withSettings({ categoryBudgets: { Groceries: 50000 } }),
    );
    const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method, body: init?.body });
        return { ok: true, json: async () => ({ ok: true, settings: {} }) };
      }),
    );
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    fireEvent.change(screen.getByLabelText("Available floor, in pounds"), {
      target: { value: "12000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const put = calls.find((c) => c.url === "/api/settings");
    expect(put?.method).toBe("PUT");
    expect(JSON.parse(put!.body!)).toEqual({
      availableFloorMinor: 1200000,
      overallMonthlyBudgetMinor: null,
      categoryBudgets: { Groceries: 50000 },
    });
  });

  it("clearing a budgeted category's field sends an explicit null for it", async () => {
    hydrateData(withSettings({ categoryBudgets: { Groceries: 50000 } }));
    const calls: { url: string; body: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body });
        return { ok: true, json: async () => ({ ok: true, settings: {} }) };
      }),
    );
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    fireEvent.change(
      screen.getByLabelText("Monthly budget for Groceries, in pounds"),
      { target: { value: "" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const put = calls.find((c) => c.url === "/api/settings");
    expect(JSON.parse(put!.body!).categoryBudgets).toEqual({
      Groceries: null,
    });
  });

  it("a negative amount blocks the save with an inline error and no request", async () => {
    hydrateData(SAMPLE_SNAPSHOT);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    fireEvent.change(
      screen.getByLabelText("Overall monthly budget, in pounds"),
      { target: { value: "-5" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/£0 or more/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Danger-colour contrast, computed from the actual tokens in
 * styles.css with the same OKLCH → WCAG luminance method as
 * theme-contrast.test.tsx: text-destructive on the card and page
 * surfaces, and --danger-on-hero against every hero gradient stop,
 * in both themes, must clear 4.5:1.
 */
type Oklab = [number, number, number];
function oklch(l: number, c: number, h: number): Oklab {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}
function luminance([l, a, b]: Oklab): number {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const [l3, m3, s3] = [lp ** 3, mp ** 3, sp ** 3];
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
function contrast(fg: Oklab, bg: Oklab): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
function themeBlock(selector: string): string {
  const start = css.indexOf(selector);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}
function token(block: string, name: string): Oklab {
  const m = block.match(
    new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  if (!m) throw new Error(`token --${name} not found`);
  return oklch(Number(m[1]), Number(m[2]), Number(m[3]));
}
function gradientStops(selector: string): Oklab[] {
  const m = css.match(
    new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*linear-gradient\\(135deg, oklch\\(([\\d. ]+)\\), oklch\\(([\\d. ]+)\\)\\)`,
    ),
  );
  if (!m) throw new Error(`gradient stops not found for ${selector}`);
  return [m[1]!, m[2]!].map((s) => {
    const [l, c, h] = s.trim().split(/\s+/).map(Number) as [number, number, number];
    return oklch(l, c, h);
  });
}

describe("danger colours clear WCAG AA in both themes", () => {
  const light = themeBlock(":root {");
  const dark = themeBlock(".dark {");

  it("text-destructive on card and page backgrounds", () => {
    for (const [name, block] of [["light", light], ["dark", dark]] as const) {
      const fg = token(block, "destructive");
      expect(contrast(fg, token(block, "card")), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, token(block, "background")), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--danger-on-hero against every hero gradient stop", () => {
    const lightStops = gradientStops(".hero-panel");
    const darkStops = gradientStops(".dark .hero-panel");
    for (const stop of lightStops) {
      expect(contrast(token(light, "danger-on-hero"), stop)).toBeGreaterThanOrEqual(4.5);
    }
    for (const stop of darkStops) {
      expect(contrast(token(dark, "danger-on-hero"), stop)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
