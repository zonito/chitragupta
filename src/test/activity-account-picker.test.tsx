import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider, usePerson } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";

/**
 * The Activity account picker: the filter row's own way into the
 * account scope that used to arrive only from a Cards deep link.
 * Both controls drive the one accountScope state — choosing in the
 * picker raises the chip, clearing either clears both — and the
 * sticky listed-total names the account while scoped.
 *
 * Fixture account ids are patched onto the sample rows by label:
 *   Revolut Main · Zonito    → Main        (Zonito)
 *   Revolut Pro · Zonito     → Pro         (Zonito)  £189.25 / 4 rows
 *   Joint Bills · Revolut    → Joint       (stored under Zonito)
 *   Monzo Current · Nikhila  → Monzo Current (Nikhila)
 *   Amex Gold · Nikhila      → Amex Gold   (Nikhila)
 * Pro spend, hand-summed: 86.50 + 38.20 + 46.80 + 17.75 = £189.25.
 */

const ACCOUNT_ID_BY_LABEL: Record<string, string> = {
  "Revolut Main · Zonito": "Main",
  "Revolut Pro · Zonito": "Pro",
  "Joint Bills · Revolut": "Joint",
  "Monzo Current · Nikhila": "Monzo Current",
  "Amex Gold · Nikhila": "Amex Gold",
};

function hydrateWithAccountIds() {
  const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
  snap.txns = SAMPLE_TXNS.map((t): Txn => {
    const accountId = ACCOUNT_ID_BY_LABEL[t.account];
    return accountId ? { ...t, accountId } : t;
  });
  hydrateData(snap);
}

function ViewSwitch() {
  const { setPerson } = usePerson();
  return (
    <>
      <button type="button" onClick={() => setPerson("household")}>
        View as Household
      </button>
      <button type="button" onClick={() => setPerson("zonito")}>
        View as Zonito
      </button>
      <button type="button" onClick={() => setPerson("nikhila")}>
        View as Nikhila
      </button>
    </>
  );
}

function renderActivity() {
  return render(
    <PersonProvider>
      <ViewSwitch />
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

const picker = () => screen.getByLabelText("Account") as HTMLSelectElement;
const summaryText = () => screen.getByTestId("listed-summary").textContent ?? "";

beforeEach(() => {
  window.history.pushState({}, "", "/activity");
  hydrateWithAccountIds();
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity account picker", () => {
  it("lists every account grouped by person with the emoji group labels", () => {
    renderActivity();
    const select = picker();
    expect(select.value).toBe("all");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => [
        (o as HTMLOptionElement).value,
        o.textContent,
      ]),
    }));
    expect(groups).toEqual([
      {
        label: "👨 Zonito",
        options: [
          ["zonito:Main", "Revolut Main"],
          ["zonito:Pro", "Revolut Pro"],
          ["zonito:Savings-9000000002", "Revolut Savings"],
          ["zonito:Joint", "Joint Bills"],
        ],
      },
      {
        label: "👩 Nikhila",
        options: [
          ["nikhila:Monzo Current", "Monzo Current"],
          ["nikhila:Amex Gold", "Amex Gold"],
        ],
      },
    ]);
    expect(select.querySelector('option[value="all"]')?.textContent).toBe(
      "All accounts",
    );
  });

  it("choosing an account scopes the list and the listed total, and raises the chip", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    fireEvent.change(picker(), { target: { value: "zonito:Pro" } });

    expect(picker().value).toBe("zonito:Pro");
    expect(text()).toContain("Dishoom King's Cross");
    expect(text()).toContain("Padella");
    expect(text()).not.toContain("Ocado");
    expect(text()).not.toContain("Pret A Manger");
    // The sticky total names the account and sums only its rows.
    expect(summaryText()).toContain("Revolut Pro");
    expect(summaryText()).toContain("£189.25 spent");
    expect(summaryText()).toContain("4 transactions");
    // The chip rides along, carrying the same scope.
    expect(screen.getByLabelText("Clear account filter")).toBeTruthy();
  });

  it("clearing the chip clears the picker too", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    fireEvent.change(picker(), { target: { value: "zonito:Pro" } });
    expect(text()).not.toContain("Ocado");

    fireEvent.click(screen.getByLabelText("Clear account filter"));
    expect(picker().value).toBe("all");
    expect(screen.queryByLabelText("Clear account filter")).toBeNull();
    expect(text()).toContain("Ocado");
    expect(summaryText()).toContain("48 transactions");
  });

  it("a Cards deep-link scope is reflected in the picker, and All accounts clears it", () => {
    window.history.pushState(
      {},
      "",
      "/activity?account=Main&accountPerson=zonito",
    );
    renderActivity();
    expect(picker().value).toBe("zonito:Main");
    expect(screen.getByLabelText("Clear account filter")).toBeTruthy();

    fireEvent.change(picker(), { target: { value: "all" } });
    expect(picker().value).toBe("all");
    expect(screen.queryByLabelText("Clear account filter")).toBeNull();
    expect(summaryText()).toContain("48 transactions");
  });

  it("a single-person view offers only that person's accounts", () => {
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: "View as Zonito" }));
    let groups = [...picker().querySelectorAll("optgroup")];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("👨 Zonito");
    expect(groups[0]!.querySelectorAll("option")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "View as Nikhila" }));
    groups = [...picker().querySelectorAll("optgroup")];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("👩 Nikhila");
    expect(groups[0]!.querySelectorAll("option")).toHaveLength(2);
  });
});
