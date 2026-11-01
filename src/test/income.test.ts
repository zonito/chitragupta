import { describe, expect, it } from "vitest";
import { INCOME, incomeFor, incomeTotal, type Person } from "@/lib/data";

describe("October income", () => {
  it("records Zonito's £7,240 salary on 25 October", () => {
    expect(INCOME.find((entry) => entry.owner === "zonito")).toEqual({
      day: 25,
      amount: 7240,
      owner: "zonito",
      type: "Salary",
    });
  });
  it("records Nikhila's £4,860 salary on 28 October", () => {
    expect(INCOME.find((entry) => entry.owner === "nikhila")).toEqual({
      day: 28,
      amount: 4860,
      owner: "nikhila",
      type: "Salary",
    });
  });
  it.each<[Person, number, string[]]>([
    ["household", 12100, ["zonito", "nikhila"]],
    ["zonito", 7240, ["zonito"]],
    ["nikhila", 4860, ["nikhila"]],
  ])(
    "includes only the correct salary entries for %s",
    (person, total, owners) => {
      expect(incomeTotal(person)).toBe(total);
      expect(incomeFor(person).map((entry) => entry.owner)).toEqual(owners);
    },
  );
});
