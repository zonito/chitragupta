import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Part 1 of the Activity pass: a category correction made in the
 * detail sheet reflects instantly — in the open sheet, in the list
 * rows behind it and (via the same derived rows) the totals — without
 * closing or reopening anything. The sheet used to render the object
 * captured on tap while the refreshed snapshot never re-derived the
 * list memos (the module arrays keep their identity across hydration),
 * so the pick appeared to snap back. A failed save reverts the select
 * and says so quietly.
 */

function renderActivity() {
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

function stubMerchants(mode: "ok" | "fail") {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).includes("/api/merchants")) {
      if (mode === "fail") {
        return new Response(JSON.stringify({ ok: false, error: "nope" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, transactions: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The list row buttons for a merchant (the sheet is not a row). */
function merchantRows(merchant: string, amount: string) {
  return screen
    .getAllByText(merchant)
    .map((el) => el.closest("button"))
    .filter((b): b is HTMLButtonElement => !!b && (b.textContent ?? "").includes(amount));
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity category correction (instant reflection)", () => {
  it("a successful pick updates the open sheet and every list row of the merchant at once", async () => {
    const fetchMock = stubMerchants("ok");
    renderActivity();

    fireEvent.click(merchantRows("Pret A Manger", "£7.45")[0]!);
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("Eating out");

    fireEvent.change(select, { target: { value: "Groceries" } });

    // The save went out with the store merchant string and user source.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/merchants",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            merchant: "Pret A Manger",
            category: "Groceries",
            source: "user",
          }),
        }),
      ),
    );
    // The sheet never closed and its select holds the new category.
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("Groceries"));
    expect((select as HTMLSelectElement).disabled).toBe(false);
    // All three Pret rows in the list behind now wear the Groceries
    // chip — the correction is merchant-level and instant, no remount.
    const rows = merchantRows("Pret A Manger", "£7.45");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.textContent).toContain("Groceries");
      expect(row.textContent).not.toContain("Eating out");
    }
  });

  it("a failed save puts the select and the rows back and shows the error", async () => {
    stubMerchants("fail");
    renderActivity();

    fireEvent.click(merchantRows("Pret A Manger", "£7.45")[0]!);
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("Eating out");

    fireEvent.change(select, { target: { value: "Groceries" } });

    expect(
      await within(dialog).findByText(
        "Could not save that category — it has been put back.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("Eating out"));
    const rows = merchantRows("Pret A Manger", "£7.45");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.textContent).toContain("Eating out");
      expect(row.textContent).not.toContain("Groceries");
    }
  });
});
