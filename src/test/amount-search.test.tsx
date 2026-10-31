import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import { amountMatchesQuery, parseAmountQuery } from "@/lib/amount-search";
import { openStore } from "@/lib/ingest/store";

/**
 * Part 4 of the Activity pass: search matches amounts in BOTH paths —
 * the client filter over snapshot months and /api/transactions' q
 * over fetched months — with one shared semantics (amount-search):
 * a numeric query matches on exact absolute equality or when the
 * amount's canonical two-decimal string starts with the query text.
 * Non-numeric queries behave exactly as before.
 */

describe("parseAmountQuery", () => {
  it("accepts plain amounts, £ signs, commas and two-decimal forms", () => {
    expect(parseAmountQuery("148")).toEqual({ minor: 14800, text: "148" });
    expect(parseAmountQuery("148.00")).toEqual({ minor: 14800, text: "148.00" });
    expect(parseAmountQuery("£148")).toEqual({ minor: 14800, text: "148" });
    expect(parseAmountQuery("£1,284")).toEqual({ minor: 128400, text: "1284" });
    expect(parseAmountQuery("7.45")).toEqual({ minor: 745, text: "7.45" });
    expect(parseAmountQuery(" 12 ")).toEqual({ minor: 1200, text: "12" });
  });

  it("rejects anything that is not a plain amount", () => {
    for (const q of ["ocado", "", "12.345", "-5", "1e3", "12a", "£", ".5"]) {
      expect(parseAmountQuery(q), q).toBeNull();
    }
  });
});

describe("amountMatchesQuery", () => {
  it("matches exactly and by canonical-string prefix, nothing else", () => {
    expect(amountMatchesQuery(148, parseAmountQuery("148")!)).toBe(true);
    expect(amountMatchesQuery(148, parseAmountQuery("148.00")!)).toBe(true);
    expect(amountMatchesQuery(128.04, parseAmountQuery("128")!)).toBe(true);
    expect(amountMatchesQuery(1284, parseAmountQuery("128")!)).toBe(true);
    expect(amountMatchesQuery(7.45, parseAmountQuery("7.4")!)).toBe(true);
    expect(amountMatchesQuery(128.4, parseAmountQuery("128")!)).toBe(true);
    expect(amountMatchesQuery(129, parseAmountQuery("128")!)).toBe(false);
    expect(amountMatchesQuery(12.8, parseAmountQuery("128")!)).toBe(false);
    expect(amountMatchesQuery(14.85, parseAmountQuery("148")!)).toBe(false);
    // Prefix is on the displayed string, so £148.50 does start "148".
    expect(amountMatchesQuery(148.5, parseAmountQuery("148")!)).toBe(true);
  });
});

// ---- Client path (snapshot months) ----

function renderActivity() {
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

const search = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value } });

describe("Activity amount search (client)", () => {
  beforeEach(() => {
    hydrateData(SAMPLE_SNAPSHOT);
    window.history.pushState({}, "", "/");
  });
  afterEach(() => hydrateData(SAMPLE_SNAPSHOT));

  it("an exact amount query finds only the rows of that amount", () => {
    renderActivity();
    search("7.45");
    expect(screen.getAllByText("Pret A Manger")).toHaveLength(3);
    expect(screen.queryByText("Ocado")).toBeNull();
    expect(screen.queryByText("Spotify Family")).toBeNull();
  });

  it("a prefix query finds £112.40 but not the other Ocado amounts", () => {
    renderActivity();
    search("112.4");
    expect(screen.getByText("−£112.40")).toBeTruthy();
    expect(screen.queryByText("−£98.75")).toBeNull();
    expect(screen.queryByText("−£124.10")).toBeNull();
  });

  it("'128' reaches the £1,284 Jet2 row through the prefix rule", () => {
    renderActivity();
    search("128");
    expect(screen.getByText("Jet2 Holidays · Tenerife Feb")).toBeTruthy();
    expect(screen.getByText("−£1,284.00")).toBeTruthy();
    expect(screen.queryByText("Pret A Manger")).toBeNull();
  });

  it("amount search composes with the category filter", () => {
    renderActivity();
    const catSelect = screen
      .getByRole("option", { name: "Groceries" })
      .closest("select")!;
    fireEvent.change(catSelect, { target: { value: "Groceries" } });
    search("112.4");
    expect(screen.getByText("−£112.40")).toBeTruthy();
    // The £1,284 Holidays row is out of scope under Groceries.
    search("128");
    expect(screen.queryByText("Jet2 Holidays · Tenerife Feb")).toBeNull();
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });

  it("a non-numeric query still searches merchant text only", () => {
    renderActivity();
    search("spotify");
    expect(screen.getByText("Spotify Family")).toBeTruthy();
    expect(screen.queryByText("Pret A Manger")).toBeNull();
  });
});

// ---- Server path (/api/transactions q) ----

const ENV_KEY = "CHITRAGUPTA_STORE_DIR";
const savedStoreDir = process.env[ENV_KEY];
const dirs: string[] = [];

afterAll(() => {
  if (savedStoreDir === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedStoreDir;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function seededApi() {
  const dir = mkdtempSync(join(tmpdir(), "chitra-amt-"));
  dirs.push(dir);
  const db = openStore(dir);
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
       description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, '2026-09', ?, ?, ?, 0, 'GBP', 0, 'spend', 'Groceries')`,
  );
  insert.run("a1", "2026-09-03", "Penny Caulfield", "Penny Caulfield", -14800);
  insert.run("a2", "2026-09-04", "Adyen N.v.", "Adyen N.v.", -12804);
  insert.run("a3", "2026-09-05", "Jet2", "Jet2", -128400);
  insert.run("a4", "2026-09-06", "Pret A Manger", "Pret A Manger", -745);
  db.close();
  vi.resetModules();
  process.env[ENV_KEY] = dir;
  return import("@/lib/api");
}

async function queryIds(q: string): Promise<string[]> {
  const api = await seededApi();
  const res = (await api.handleChitraguptaApi(
    new Request(`http://local/api/transactions?q=${encodeURIComponent(q)}&limit=50`),
  ))!;
  expect(res.status).toBe(200);
  const body = (await res.json()) as { transactions: { id: string }[] };
  return body.transactions.map((t) => t.id).sort();
}

describe("/api/transactions amount search (server)", () => {
  it("exact: q=148 and q=148.00 find only the £148.00 row", async () => {
    expect(await queryIds("148")).toEqual(["a1"]);
    expect(await queryIds("148.00")).toEqual(["a1"]);
  });

  it("prefix: q=128 finds £128.04 and £1,284.00", async () => {
    expect(await queryIds("128")).toEqual(["a2", "a3"]);
    expect(await queryIds("7.45")).toEqual(["a4"]);
  });

  it("a text query still matches merchants, and a near-miss amount finds nothing", async () => {
    expect(await queryIds("penny")).toEqual(["a1"]);
    expect(await queryIds("129")).toEqual([]);
  });
});
