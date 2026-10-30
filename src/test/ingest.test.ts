import { describe, expect, it } from "vitest";
import {
  classifyMovement,
  gbpPence,
  parseAccountCsv,
  parseSavingsCsv,
} from "@/lib/ingest/parse";

describe("CSV parsing", () => {
  it("parses account statements and skips the header", () => {
    const rows = parseAccountCsv(
      "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n" +
        "Transfer,Current,2026-02-02 16:59:37,2026-02-02 16:59:38,To Gepp & Sons Solicitors Llp,-47100.00,0.00,GBP,COMPLETED,3058.90\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("To Gepp & Sons Solicitors Llp");
    expect(rows[0]!.amount).toBe("-47100.00");
  });

  it("parses savings statements and skips repeated header rows", () => {
    const rows = parseSavingsCsv(
      "Date,Description,Money out,Money in,Balance\n" +
        '"Jan 25, 2026",Deposit,,£3.50,£3.50\n' +
        "Date,Description,Money out,Money in,Balance\n" +
        '"Jan 26, 2026",Deposit,,£1.00,£4.50\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.balance).toBe("£4.50");
  });
});

describe("netting rules", () => {
  it("Gepp & Sons payments are capital (Moved aside), never spending", () => {
    expect(
      classifyMovement(
        "Transfer",
        "To Gepp & Sons Solicitors Llp",
        -4710000,
        "GBP",
      ),
    ).toBe("aside");
    expect(
      classifyMovement(
        "Transfer",
        "To Gepp & Sons Solicitors Llp",
        -13438223,
        "GBP",
      ),
    ).toBe("aside");
  });

  it("IBKR and Trading 212 moves are Moved aside", () => {
    expect(classifyMovement("Transfer", "To IBKR LLC", -100000, "GBP")).toBe(
      "aside",
    );
    expect(
      classifyMovement("Transfer", "To Trading 212 UK Limited", -100000, "EUR"),
    ).toBe("aside");
    expect(
      classifyMovement("Transfer", "To investment account", -50000, "GBP"),
    ).toBe("aside");
  });

  it("own-account and pocket transfers are internal", () => {
    expect(classifyMovement("Transfer", "To GBP Pro", -20000, "GBP")).toBe(
      "internal",
    );
    expect(classifyMovement("Exchange", "Exchanged to EUR", 11516, "EUR")).toBe(
      "internal",
    );
    expect(
      classifyMovement(
        "Transfer",
        "Transfer to LOVE KUMAR SHARMA",
        50000,
        "USD",
      ),
    ).toBe("internal");
  });

  it("transfers involving Nikhila are internal at household level", () => {
    expect(
      classifyMovement("Transfer", "Transfer to NIKHILA SHARMA", -10000, "GBP"),
    ).toBe("internal");
    expect(
      classifyMovement("Transfer", "Transfer to DHYANI SHARMA", -250, "GBP"),
    ).toBe("internal");
  });

  it("reverted rows are never movements", () => {
    expect(classifyMovement("Reverted", "Anything", -999, "GBP")).toBe(
      "internal",
    );
  });

  it("fees and interest keep their own categories", () => {
    expect(classifyMovement("Card Payment", "Revolut fee", -100, "GBP")).toBe(
      "fee",
    );
    expect(classifyMovement("Deposit", "Gross Interest", 2, "GBP")).toBe(
      "interest",
    );
  });

  it("ordinary card spend stays spend, deposits stay income", () => {
    expect(classifyMovement("Card Payment", "Ocado", -11240, "GBP")).toBe(
      "spend",
    );
    expect(classifyMovement("Deposit", "Salary", 300000, "GBP")).toBe("income");
  });
});

describe("gbpPence", () => {
  it("parses £ amounts with commas", () => {
    expect(gbpPence("£1,500.00")).toBe(150000);
    expect(gbpPence("£0.02")).toBe(2);
    expect(gbpPence("-47100.00")).toBe(-4710000);
    expect(gbpPence("")).toBe(0);
  });
});
