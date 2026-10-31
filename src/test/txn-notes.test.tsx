import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type Database from "better-sqlite3";

import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Follow-up 5: the user's own notes on transactions (txn_notes, keyed
 * by fingerprint). The detail sheet gains a Notes field and a
 * copyable transaction ID; list rows show a note indicator; search
 * matches note text in both the snapshot (client) and fetched-month
 * (server q) paths; notes survive an ingest rebuild.
 */

const mkTxn = (over: Partial<Txn>): Txn => ({
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

function hydrateNotes() {
  const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
  snap.txns = [
    mkTxn({ id: "fp-note-1", merchant: "Ocado", userNote: "purple banana hammock" }),
    mkTxn({ id: "fp-plain-1", merchant: "Tesco", date: "2026-10-19", day: 19 }),
  ];
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

const writeText = vi.fn(async () => {});

beforeEach(() => {
  hydrateNotes();
  localStorage.clear();
  window.history.pushState({}, "", "/");
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  // The note endpoint, mirrored: trimmed note back, empty clears.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/transactions/note")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: string; note?: string };
        const note = (body.note ?? "").trim();
        return new Response(JSON.stringify({ ok: true, id: body.id, note: note || null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, transactions: [] }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Activity notes", () => {
  it("search matches a word that appears only in a note, and the row shows the note indicator", () => {
    renderActivity();
    expect(screen.getByLabelText("Has a note")).toBeTruthy();
    const search = screen.getByPlaceholderText(/Search/);
    fireEvent.change(search, { target: { value: "banana" } });
    expect(screen.getByText("Ocado")).toBeTruthy();
    expect(screen.queryByText("Tesco")).toBeNull();
    fireEvent.change(search, { target: { value: "Tesco" } });
    expect(screen.getByText("Tesco")).toBeTruthy();
    expect(screen.queryByText("Ocado")).toBeNull();
  });

  it("the sheet carries the note editor, the transaction id and a working copy control", async () => {
    renderActivity();
    fireEvent.click(screen.getByText("Ocado"));
    const area = await screen.findByLabelText("Your note");
    expect((area as HTMLTextAreaElement).value).toBe("purple banana hammock");
    expect(screen.getByText("Transaction ID")).toBeTruthy();
    expect(screen.getByText("fp-note-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy transaction ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("fp-note-1"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("saving a note posts it and the row gains the indicator immediately", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    renderActivity();
    fireEvent.click(screen.getByText("Tesco"));
    const area = await screen.findByLabelText("Your note");
    // Nothing to save yet: a flat muted pill (disabled, full opacity)
    // — never the faded half-strength primary that read as broken.
    const saveButton = screen.getByRole("button", { name: "Save note" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton.className).toContain("bg-muted");
    expect(saveButton.className).toContain("disabled:opacity-100");
    expect(saveButton.className).not.toContain("bg-primary");
    fireEvent.change(area, { target: { value: "gift for mum" } });
    // Something to save: the secondary tint treatment, enabled — a
    // light teal tint with deep teal text, never the full-strength
    // primary fill (too dark) nor the muted nothing-to-save pill.
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    expect(saveButton.className).toContain("bg-primary/15");
    expect(saveButton.className).toContain("text-primary");
    expect(saveButton.className).toContain("shadow-none");
    expect(saveButton.className.split(/\s+/)).not.toContain("bg-primary");
    expect(saveButton.className).not.toContain("bg-muted");
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/transactions/note",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ id: "fp-plain-1", note: "gift for mum" }),
        }),
      ),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByLabelText("Has a note")).toHaveLength(2));
  });

  it("the Save note states are token classes, identical under the dark theme", async () => {
    // The tint/muted treatments are semantic-token classes (bg-primary
    // at 15%, text-primary, bg-muted): the .dark token overrides in
    // the stylesheet resolve them per theme, so the class contract is
    // the same in both themes — a tint that still reads as a tint in
    // dark, and a muted pill clearly distinct from it.
    render(
      <div className="dark">
        <PersonProvider>
          <DocumentsProvider>
            <Activity />
          </DocumentsProvider>
        </PersonProvider>
      </div>,
    );
    fireEvent.click(screen.getByText("Tesco"));
    const area = await screen.findByLabelText("Your note");
    const saveButton = screen.getByRole("button", { name: "Save note" });
    expect(saveButton.className).toContain("bg-muted");
    expect(saveButton.className).not.toContain("bg-primary");
    fireEvent.change(area, { target: { value: "dark theme note" } });
    expect(saveButton.className).toContain("bg-primary/15");
    expect(saveButton.className).toContain("hover:bg-primary/25");
    expect(saveButton.className).toContain("text-primary");
    expect(saveButton.className.split(/\s+/)).not.toContain("bg-primary");
    expect(saveButton.className).not.toContain("text-primary-foreground");
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: HTTP round-trip, server search, snapshot carriage and
// survival across an atomic rebuild, on a store built from the real
// fixture.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

describe.runIf(BOTH_PEOPLE)("Transaction notes (repro2, HTTP)", () => {
  let db: Database.Database;
  let storeDir: string;
  let fp = "";
  let api: (req: Request) => Promise<Response | null>;

  const post = (path: string, body?: unknown, method = "POST") =>
    api(
      new Request(`http://test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const getNote = async (id: string): Promise<string | null> => {
    const res = await api(new Request(`http://test/api/transactions?ids=${encodeURIComponent(id)}`));
    const body = (await res!.json()) as { transactions: { userNote?: string | null }[] };
    return body.transactions[0]?.userNote ?? null;
  };

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const { handleChitraguptaApi } = await import("@/lib/api");
    api = handleChitraguptaApi as typeof api;
    storeDir = mkdtempSync(join(tmpdir(), "chitra-notes-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const row = db
      .prepare(
        "SELECT fingerprint FROM transactions WHERE movement = 'spend' AND year_month = '2026-10' LIMIT 1",
      )
      .get() as { fingerprint: string };
    fp = row.fingerprint;
  }, 180_000);

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("round-trips set → read → edit → clear over HTTP", async () => {
    let res = await post("/api/transactions/note", { id: fp, note: "zzq note one" });
    expect(((await res!.json()) as { note: string | null }).note).toBe("zzq note one");
    expect(await getNote(fp)).toBe("zzq note one");

    res = await post("/api/transactions/note", { id: fp, note: "zzq note two" });
    expect(((await res!.json()) as { note: string | null }).note).toBe("zzq note two");
    expect(await getNote(fp)).toBe("zzq note two");

    res = await post("/api/transactions/note", { id: fp, note: "  " });
    expect(((await res!.json()) as { note: string | null }).note).toBeNull();
    expect(await getNote(fp)).toBeNull();
  });

  it("server search finds a transaction by a word that appears only in its note", async () => {
    await post("/api/transactions/note", { id: fp, note: "zzqonlyword present" });
    const hit = (await (
      await api(new Request("http://test/api/transactions?q=zzqonlyword"))
    )!.json()) as { transactions: { id: string }[] };
    expect(hit.transactions.map((t) => t.id)).toContain(fp);
    const miss = (await (
      await api(new Request("http://test/api/transactions?q=zzqabsentword"))
    )!.json()) as { transactions: { id: string }[] };
    expect(miss.transactions.map((t) => t.id)).not.toContain(fp);
  });

  it("the snapshot carries the note, and it survives an ingest rebuild", async () => {
    await post("/api/transactions/note", { id: fp, note: "zzq keep through rebuild" });
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    const inSnapshot = buildSnapshot().txns.find((t) => t.id === fp);
    expect(inSnapshot?.userNote).toBe("zzq keep through rebuild");

    // Force the atomic rebuild path (stale rules version), re-ingest
    // through the API, and confirm the note still resolves.
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'rules_version'").run();
    const run = await post("/api/ingest/run");
    expect(((await run!.json()) as { ok: boolean }).ok).toBe(true);
    expect(await getNote(fp)).toBe("zzq keep through rebuild");
    const after = buildSnapshot().txns.find((t) => t.id === fp);
    expect(after?.userNote).toBe("zzq keep through rebuild");
  });
});
