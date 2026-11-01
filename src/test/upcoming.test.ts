import { describe, expect, it } from "vitest";
import {
  UPCOMING,
  upcomingFor,
  upcomingPanel,
  upcomingShare,
  upcomingTotal,
  type Person,
} from "@/lib/data";

describe("November known regular payments", () => {
  it.each([
    ["Enfield Council Tax", 1, 186, "joint"],
    ["Octopus Energy", 1, 138, "joint"],
    ["Spotify Family", 2, 19.99, "zonito"],
    ["Hyperoptic", 4, 30, "joint"],
    ["Netflix", 5, 18.99, "zonito"],
    ["ParentPay school lunches", 5, 68, "nikhila"],
    ["iCloud+", 8, 8.99, "nikhila"],
    ["Disney+", 15, 9.99, "nikhila"],
    ["Thames Water", 15, 42, "joint"],
    ["PureGym", 21, 34.99, "nikhila"],
    ["The Times", 14, 26, "zonito"],
  ])(
    "keeps %s on the supplied November date and amount",
    (name, day, amount, owner) => {
      expect(UPCOMING.find((p) => p.name === name)).toEqual({
        name,
        day,
        date: `2026-11-${String(day).padStart(2, "0")}`,
        amount,
        owner,
      });
    },
  );
  it("splits joint payments 50/50 and excludes the other person's payments", () => {
    const bill = UPCOMING.find((p) => p.name === "Octopus Energy");
    const netflix = UPCOMING.find((p) => p.name === "Netflix");
    if (!bill || !netflix) throw new Error("Missing regulars");
    expect(upcomingShare(bill, "household")).toBe(138);
    expect(upcomingShare(bill, "zonito")).toBe(69);
    expect(upcomingShare(bill, "nikhila")).toBe(69);
    expect(upcomingShare(netflix, "nikhila")).toBe(0);
    expect(upcomingShare(netflix, "zonito")).toBe(18.99);
  });
  it.each<[Person, number]>([
    ["household", 582.95],
    ["zonito", 262.98],
    ["nikhila", 319.97],
  ])("sums known commitments for %s", (person, total) => {
    expect(upcomingTotal(person)).toBeCloseTo(total, 2);
  });
  it.each<[Person, string[]]>([
    [
      "household",
      [
        "Enfield Council Tax",
        "Octopus Energy",
        "Spotify Family",
        "Hyperoptic",
        "Netflix",
      ],
    ],
    [
      "zonito",
      [
        "Enfield Council Tax",
        "Octopus Energy",
        "Spotify Family",
        "Hyperoptic",
        "Netflix",
      ],
    ],
    [
      "nikhila",
      [
        "Enfield Council Tax",
        "Octopus Energy",
        "Hyperoptic",
        "ParentPay school lunches",
        "iCloud+",
      ],
    ],
  ])(
    "shows the next five regulars by date for %s in the panel",
    (person, names) => {
      expect(upcomingPanel(person).visible.map((p) => p.name)).toEqual(names);
      const dates = upcomingFor(person).map((p) => p.date);
      expect(dates).toEqual([...dates].sort());
    },
  );
  it.each<[Person]>([["household"], ["zonito"], ["nikhila"]])(
    "panel accounts for the headline total exactly for %s: visible rows plus the 'and N more' remainder",
    (person) => {
      const panel = upcomingPanel(person);
      const visibleSum = panel.visible.reduce(
        (sum, p) => sum + upcomingShare(p, person),
        0,
      );
      expect(panel.total).toBeCloseTo(upcomingTotal(person), 2);
      expect(visibleSum + panel.restTotal).toBeCloseTo(panel.total, 2);
      expect(panel.restCount).toBe(
        upcomingFor(person).length - panel.visible.length,
      );
      expect(panel.visible.length).toBeLessThanOrEqual(5);
      if (panel.restCount === 0) expect(panel.restTotal).toBe(0);
      else expect(panel.restTotal).toBeGreaterThan(0);
    },
  );
});
