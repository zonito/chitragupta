import { describe, expect, it } from "vitest";
import { tripAnswer, TXNS, type Person } from "@/lib/data";

describe("Ask trip example", () => {
  it.each<[Person, number, string[]]>([
    [
      "household",
      1555.4,
      ["Jet2 Holidays · Tenerife Feb", "Airbnb · Lisbon half-term"],
    ],
    ["zonito", 1284, ["Jet2 Holidays · Tenerife Feb"]],
    ["nikhila", 271.4, ["Airbnb · Lisbon half-term"]],
  ])("totals Holidays shares for %s", (person, total, merchants) => {
    const answer = tripAnswer(person);
    expect(answer.total).toBeCloseTo(total, 2);
    expect(answer.orders.map((t) => t.merchant)).toEqual(merchants);
    expect(answer.fallback).toBe(false);
  });
  it("falls back to household figures when there are no personal bookings", () => {
    const rows = TXNS.filter((t) => t.owner === "zonito");
    const answer = tripAnswer("nikhila", rows);
    expect(answer.fallback).toBe(true);
    expect(answer.answerPerson).toBe("household");
    expect(answer.total).toBe(1284);
    expect(answer.orders).toHaveLength(1);
  });
});
