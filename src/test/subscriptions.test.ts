import { describe, expect, it } from "vitest";
import {
  canonicalMerchant,
  detectSubscriptions,
  type SubCharge,
} from "@/lib/subscriptions";

const fmt = {
  dateLabel: (iso: string) => iso,
  accountLabel: (account: string) => account,
};

const c = (
  merchant: string,
  date: string,
  amountMinor: number,
  account = "Main",
  person = "zonito",
): SubCharge => ({ merchant, date, amountMinor, account, person });

const LATEST = "2026-10-30";

describe("canonicalMerchant", () => {
  it("merges a trailing-mobile name variant and keeps distinct merchants apart", () => {
    expect(canonicalMerchant("Lebara mobile")).toBe(canonicalMerchant("Lebara"));
    expect(canonicalMerchant("Google Cloud")).not.toBe(
      canonicalMerchant("Google Endel Sound"),
    );
  });
});

describe("detectSubscriptions", () => {
  it("rejects a grocery merchant visited monthly at varying amounts", () => {
    const charges = [
      c("Corner Grocers", "2026-05-03", -4200),
      c("Corner Grocers", "2026-06-02", -5530),
      c("Corner Grocers", "2026-07-04", -6110),
      c("Corner Grocers", "2026-08-03", -4750),
      c("Corner Grocers", "2026-09-05", -7020),
      c("Corner Grocers", "2026-10-04", -3890),
    ];
    expect(detectSubscriptions(charges, LATEST, fmt)).toEqual([]);
  });

  it("merges two name variants of a £5 monthly charge into one Active sub", () => {
    const charges = [
      c("Lebara", "2026-06-06", -500),
      c("Lebara mobile", "2026-07-06", -500),
      c("Lebara", "2026-08-05", -500),
      c("Lebara mobile", "2026-09-04", -500),
      c("Lebara", "2026-10-05", -500),
    ];
    const subs = detectSubscriptions(charges, LATEST, fmt);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      name: "Lebara",
      amount: 5,
      freq: "Monthly",
      status: "Active",
      charges: 5,
      nextExpected: "2026-11-04",
      variants: ["Lebara", "Lebara mobile"],
    });
  });

  it("finds a repeated £4.99 monthly cluster among varying food orders", () => {
    const charges = [
      c("Deliveroo", "2026-07-03", -3160),
      c("Deliveroo", "2026-07-12", -499),
      c("Deliveroo", "2026-07-20", -2740),
      c("Deliveroo", "2026-08-12", -499),
      c("Deliveroo", "2026-08-25", -4120),
      c("Deliveroo", "2026-09-12", -499),
      c("Deliveroo", "2026-09-28", -1980),
      c("Deliveroo", "2026-10-12", -499),
    ];
    const subs = detectSubscriptions(charges, LATEST, fmt);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      name: "Deliveroo",
      amount: 4.99,
      freq: "Monthly",
      status: "Active",
      charges: 4,
    });
  });

  it("accepts a yearly pair ~365 days apart as Yearly with only 2 charges", () => {
    const charges = [
      c("bitwarden.com", "2024-11-03", -776),
      c("bitwarden.com", "2025-11-03", -776),
    ];
    const subs = detectSubscriptions(charges, LATEST, fmt);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      name: "bitwarden.com",
      amount: 7.76,
      freq: "Yearly",
      status: "Active",
      charges: 2,
    });
  });

  it("classifies a stopped monthly series as Ended, never Active", () => {
    const charges = [
      c("Peloton", "2025-05-05", -3900),
      c("Peloton", "2025-06-05", -3900),
      c("Peloton", "2025-07-05", -3900),
    ];
    const subs = detectSubscriptions(charges, LATEST, fmt);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      name: "Peloton",
      freq: "Monthly",
      status: "Ended",
      nextExpected: null,
    });
  });

  it("produces a price-increase note when the latest cluster charge rises", () => {
    const charges = [
      c("Streamly", "2026-08-02", -1000),
      c("Streamly", "2026-09-02", -1000),
      c("Streamly", "2026-10-02", -1010),
    ];
    const subs = detectSubscriptions(charges, LATEST, fmt);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ amount: 10.1, freq: "Monthly", status: "Active" });
    expect(subs[0]!.note).toBe("£10.00 → £10.10");
  });
});
