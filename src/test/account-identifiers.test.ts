import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

/**
 * AH-108: real savings account identifiers never live in the repo.
 * Discovery reads them from account-identifiers.json in the data dir
 * (outside source control). This fixture proves a synthetic statement
 * whose identifier comes only from that local file lands on the
 * correct account, and that without the file the same statement is
 * not claimed for Zonito.
 */

const SAVINGS_CSV =
  'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",Deposit,,100.00,100.00\n';
const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

function dataDir(withIdentifiers: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-ah108-data-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  writeFileSync(
    join(originals, "account-statement_2022_f5660e.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Example Shop,-10.00,0.00,GBP,COMPLETED,990.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_01cac2.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Example Shop,-5.00,0.00,GBP,COMPLETED,100.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_2151f7.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Example Stream,-15.00,0.00,USD,COMPLETED,85.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_bd9d00.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Example Grocer,-7.50,0.00,GBP,COMPLETED,50.00\n",
  );
  writeFileSync(join(originals, "savings-9000000001.csv"), SAVINGS_CSV);
  if (withIdentifiers) {
    writeFileSync(
      join(dir, "account-identifiers.json"),
      JSON.stringify({ zonito: ["Savings-9000000001"] }),
    );
  }
  return dir;
}

describe("account identifiers from local config (AH-108)", () => {
  it("matches a synthetic savings statement to the configured account", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-ah108-store-")));
    const results = ingestAll(db, dataDir(true));
    const savings = results.find((r) => r.account === "Savings-9000000001");
    expect(savings).toMatchObject({ person: "zonito", ok: true, rowsSeen: 1 });
    const stored = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE person = 'zonito' AND account = 'Savings-9000000001'",
      )
      .get() as { n: number };
    expect(stored.n).toBe(1);
    db.close();
  });

  it("without the identifiers file, Zonito savings is not discovered from constants", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-ah108-store-")));
    const results = ingestAll(db, dataDir(false));
    expect(
      results.some(
        (r) => r.person === "zonito" && r.account === "Savings-9000000001",
      ),
    ).toBe(false);
    db.close();
  });
});
