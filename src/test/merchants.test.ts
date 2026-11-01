import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@/lib/ingest/store";
import {
  NEVER_CLASSIFY_PATTERNS,
  reviewQueue,
  reviewQueueCount,
  ruleCategory,
  seedMerchantMemory,
  setMerchant,
} from "@/lib/ingest/merchants";

describe("merchant rules", () => {
  it("classifies obvious UK merchants without an API", () => {
    expect(ruleCategory("Ocado")).toBe("Groceries");
    expect(ruleCategory("Tesco")).toBe("Groceries");
    expect(ruleCategory("Waitrose & Partners")).toBe("Groceries");
    expect(ruleCategory("Transport for London")).toBe("Transport");
    expect(ruleCategory("Octopus Energy")).toBe("Home");
    expect(ruleCategory("Netflix")).toBe("Subscriptions");
    expect(ruleCategory("Spotify Family")).toBe("Subscriptions");
    expect(ruleCategory("Amazon")).toBe("Shopping");
    expect(ruleCategory("Ikea")).toBe("Shopping");
    expect(ruleCategory("Pret A Manger")).toBe("Eating out");
    expect(ruleCategory("ParentPay")).toBe("School");
  });

  it("leaves unknown merchants for the review queue", () => {
    expect(ruleCategory("Infinite Clarity")).toBeNull();
    expect(ruleCategory("Mahavir Sweet Mart")).toBe("Groceries");
  });
});

describe("merchant memory", () => {
  it("seeds rules, queues the rest, and applies overrides", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month, description, merchant, amount_minor, fee_minor, currency, balance_minor, movement)
       VALUES ('a','zonito','Main','2026-10-01','2026-10','Ocado','Ocado',-1000,0,'GBP',0,'spend'),
              ('b','zonito','Main','2026-10-02','2026-10','Infinite Clarity','Infinite Clarity',-2000,0,'GBP',0,'spend')`,
    ).run();
    const seeded = seedMerchantMemory(db);
    expect(seeded).toBe(1);
    const queue = reviewQueue(db);
    expect(queue.map((q) => q.merchant)).toContain("Infinite Clarity");
    expect(queue.map((q) => q.merchant)).not.toContain("Ocado");
    setMerchant(db, "Infinite Clarity", "Shopping", { source: "molang" });
    expect(reviewQueue(db)).toHaveLength(0);
    const row = db
      .prepare(
        `SELECT category, source FROM merchant_memory WHERE merchant = ?`,
      )
      .get("Ocado") as {
      category: string;
      source: string;
    };
    expect(row).toMatchObject({ category: "Groceries", source: "rules" });
    db.close();
  });
});

describe("review queue composition (B2/G12)", () => {
  it("keeps only spend-bearing, classifiable merchants", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-rq-")));
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month, description, merchant, amount_minor, fee_minor, currency, balance_minor, movement)
       VALUES (?, 'zonito', 'Main', '2026-10-01', '2026-10', ?, ?, ?, 0, 'GBP', 0, ?)`,
    );
    let seq = 0;
    const add = (merchant: string, movement: string, times: number) => {
      for (let i = 0; i < times; i++) {
        seq++;
        insert.run(
          `g12-${seq}`,
          merchant,
          merchant,
          movement === "spend" ? -100 : 100,
          movement,
        );
      }
    };
    // Pure-income labels (verified mixes on the real data).
    add("SHARMA L", "income", 3);
    add("LOVE KUMAR SHARMA", "income", 2);
    add("LOVE KUMAR SHARMA", "internal", 2);
    add("Deposit", "income", 2);
    add("Deposit", "internal", 2);
    add("Pro Cashback", "income", 3);
    add("Closing investment", "income", 3);
    add("FIDELITY FASL PYMT", "income", 3);
    // Spend-bearing but on the never-classify list.
    add("Investing money", "spend", 3);
    add("Fidelity Investments", "spend", 2);
    add("Pro Cashback Reversal", "spend", 2);
    // Genuine unknowns that must stay.
    add("Please Connect Me", "spend", 3);
    add("Mixed Income Spend Shop", "spend", 2);
    add("Mixed Income Spend Shop", "income", 3);

    const queue = reviewQueue(db);
    const names = queue.map((q) => q.merchant);
    for (const absent of [
      "SHARMA L",
      "LOVE KUMAR SHARMA",
      "Deposit",
      "Pro Cashback",
      "Closing investment",
      "FIDELITY FASL PYMT",
      "Investing money",
      "Fidelity Investments",
      "Pro Cashback Reversal",
    ]) {
      expect(names).not.toContain(absent);
    }
    expect(names).toContain("Please Connect Me");
    expect(names).toContain("Mixed Income Spend Shop");
    // The reported count stays the spend+income row count.
    expect(
      queue.find((q) => q.merchant === "Mixed Income Spend Shop")?.count,
    ).toBe(5);
    expect(queue.find((q) => q.merchant === "Please Connect Me")?.count).toBe(
      3,
    );
    // Count and capped list share the same filter.
    expect(reviewQueueCount(db)).toBe(2);
    expect(reviewQueueCount(db)).toBe(queue.length);
    db.close();
  });

  it("exports the minimal never-classify pattern list", () => {
    expect(NEVER_CLASSIFY_PATTERNS).toHaveLength(4);
    const matches = (m: string) =>
      NEVER_CLASSIFY_PATTERNS.some((p) => p.test(m));
    expect(matches("Investing money")).toBe(true);
    expect(matches("investing money")).toBe(true);
    expect(matches("Closing investment")).toBe(true);
    expect(matches("Pro Cashback")).toBe(true);
    expect(matches("TOPCASHBACK")).toBe(true);
    expect(matches("Fidelity Investments")).toBe(true);
    expect(matches("Please Connect Me")).toBe(false);
    expect(matches("Fidelity")).toBe(false);
  });
});
