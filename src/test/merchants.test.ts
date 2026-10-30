import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@/lib/ingest/store";
import {
  reviewQueue,
  ruleCategory,
  seedMerchantMemory,
  setMerchant,
} from "@/lib/ingest/merchants";

describe("merchant rules", () => {
  it("classifies obvious UK merchants without an API", () => {
    expect(ruleCategory("Ocado", "Card Payment", "Ocado")).toBe("Groceries");
    expect(ruleCategory("Tesco", "Card Payment", "Tesco")).toBe("Groceries");
    expect(
      ruleCategory("Waitrose & Partners", "Card Payment", "Waitrose"),
    ).toBe("Groceries");
    expect(ruleCategory("Transport for London", "Card Payment", "TfL")).toBe(
      "Transport",
    );
    expect(ruleCategory("Octopus Energy", "Card Payment", "Octopus")).toBe(
      "Home",
    );
    expect(ruleCategory("Netflix", "Card Payment", "Netflix")).toBe(
      "Subscriptions",
    );
    expect(ruleCategory("Spotify Family", "Card Payment", "Spotify")).toBe(
      "Subscriptions",
    );
    expect(ruleCategory("Amazon", "Card Payment", "Amazon")).toBe("Shopping");
    expect(ruleCategory("Ikea", "Card Payment", "Ikea")).toBe("Shopping");
    expect(ruleCategory("Pret A Manger", "Card Payment", "Pret")).toBe(
      "Eating out",
    );
    expect(ruleCategory("ParentPay", "Card Payment", "ParentPay")).toBe(
      "School",
    );
  });

  it("leaves unknown merchants for the review queue", () => {
    expect(
      ruleCategory("Infinite Clarity", "Card Payment", "Infinite Clarity"),
    ).toBeNull();
    expect(
      ruleCategory("Mahavir Sweet Mart", "Card Payment", "Mahavir Sweet Mart"),
    ).toBe("Groceries");
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
