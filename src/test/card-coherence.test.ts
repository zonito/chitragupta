import { describe, expect, it } from "vitest";
import { CARDS, SUBS, TXNS } from "@/lib/data";

describe("October card rotation", () => {
  it("keeps The Times £26 charge on 14 October before the 15 October freeze", () => {
    const times = TXNS.find((t) => t.merchant === "The Times");
    expect(times).toMatchObject({ day: 14, amount: 26, account: "Virtual ending 4412" });
    expect(SUBS.find((s) => s.name === "The Times")).toMatchObject({ last: "14 Oct", amount: 26, card: "Virtual ending 4412", status: ["Did not migrate"] });
    expect(CARDS.find((c) => c.last4 === "4412")?.frozen).toBe("15 Oct 2026");
  });
  it("has no charges on the old card after it freezes", () => {
    const charges = TXNS.filter((t) => t.account === "Virtual ending 4412");
    expect(charges).toHaveLength(3);
    expect(charges.every((t) => t.day < 15)).toBe(true);
  });
  it.each([
    ["Netflix", 5, 18.99, "5 Oct"],
    ["Spotify Family", 2, 19.99, "2 Oct"],
  ])("keeps %s to one monthly charge on the old card, with the new card configured", (name, day, amount, last) => {
    const charges = TXNS.filter((t) => t.merchant === name);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ day, amount, account: "Virtual ending 4412" });
    expect(SUBS.find((s) => s.name === name)).toMatchObject({ last, amount, freq: "Monthly", card: "Virtual ending 7730" });
  });
});