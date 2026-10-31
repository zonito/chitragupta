import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Coach } from "@/routes/coach";
import { PersonProvider } from "@/components/shell";
import { hydrateData, type Sub } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * G17: the Coach price-rise insight only counts Active subscriptions and
 * annualises the rise by the subscription's own frequency — a yearly
 * rise happens once, not twelve times.
 */

const sub = (over: Partial<Sub>): Sub => ({
  name: "Streamly",
  amount: 9.99,
  freq: "Monthly",
  last: "5 Oct 2026",
  card: "Revolut Main · Zonito",
  owner: "zonito",
  status: "Active",
  charges: 14,
  chargeIds: [],
  nextExpected: "2026-11-05",
  variants: ["Streamly"],
  ...over,
});

function renderCoach(subs: Sub[]) {
  hydrateData({ ...SAMPLE_SNAPSHOT, subs });
  return render(
    <PersonProvider>
      <Coach />
    </PersonProvider>,
  );
}

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Coach price-rise insight (G17)", () => {
  it("ignores an Ended yearly riser", () => {
    renderCoach([
      sub({
        name: "Grammarly",
        amount: 115.09,
        freq: "Yearly",
        status: "Ended",
        nextExpected: null,
        note: "£114.23 → £115.09",
        variants: ["Grammarly"],
      }),
    ]);
    expect(screen.queryByText("A subscription price went up")).toBeNull();
    expect(screen.queryByText(/more a year/)).toBeNull();
  });

  it("annualises an Active monthly riser ×12", () => {
    renderCoach([
      sub({
        name: "Netflix",
        amount: 18.99,
        freq: "Monthly",
        status: "Active",
        note: "£17.99 → £18.99",
        variants: ["Netflix"],
      }),
    ]);
    expect(screen.getByText("A subscription price went up")).toBeTruthy();
    expect(
      screen.getByText(/Netflix is now £18\.99, up from £17\.99\. That's £12\.00 more a year\./),
    ).toBeTruthy();
  });

  it("annualises an Active yearly riser ×1", () => {
    renderCoach([
      sub({
        name: "Grammarly",
        amount: 115.09,
        freq: "Yearly",
        status: "Active",
        note: "£114.23 → £115.09",
        variants: ["Grammarly"],
      }),
    ]);
    expect(
      screen.getByText(/Grammarly is now £115\.09, up from £114\.23\. That's £0\.86 more a year\./),
    ).toBeTruthy();
  });
});
