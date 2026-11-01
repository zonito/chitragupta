import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openStore } from "@/lib/ingest/store";
import { docFor, isMatched, type Doc } from "@/lib/data";

/**
 * Documents are real: POST /api/documents writes the bytes under the
 * data dir (the Drive-synced PersonalFinance folder) at the convention
 * path, records the document in the store, the snapshot serves it, the
 * file endpoint serves the bytes back, and detach keeps the record.
 */

const STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-docs-store-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "chitra-docs-data-"));
process.env["CHITRAGUPTA_STORE_DIR"] = STORE_DIR;
process.env["CHITRAGUPTA_DATA_DIR"] = DATA_DIR;

type Api = typeof import("@/lib/api");
type SnapshotServer = typeof import("@/lib/snapshot.server");
let api: Api;
let snapshotServer: SnapshotServer;

const PDF_BYTES = Buffer.from("%PDF-1.4 fake penny receipt bytes");
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const pennyPayload = {
  filename: "penny.pdf",
  contentBase64: PDF_BYTES.toString("base64"),
  type: "Receipt",
  merchant: "Penny Caulfield",
  date: "2026-10-09",
  amount: 148,
  txnId: "txn-penny",
};

async function postDocument(payload: unknown) {
  const res = await api.handleChitraguptaApi(
    new Request("http://local/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return res!;
}

let pennyDoc: Doc;

beforeAll(async () => {
  const db = openStore(STORE_DIR);
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
       description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES ('txn-penny', 'zonito', 'Main', '2026-10-09', '2026-10', 'Penny Caulfield', 'Penny Caulfield', -14800, 0, 'GBP', 0, 'spend', 'School')`,
  ).run();
  db.close();
  api = await import("@/lib/api");
  snapshotServer = await import("@/lib/snapshot.server");
});

describe("documents API", () => {
  it("writes the exact bytes at the convention path and returns the Doc", async () => {
    const res = await postDocument(pennyPayload);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; document: Doc };
    expect(body.ok).toBe(true);
    pennyDoc = body.document;
    expect(pennyDoc.id).toBeTruthy();
    expect(pennyDoc.merchant).toBe("Penny Caulfield");
    expect(pennyDoc.date).toBe("9 Oct 2026");
    expect(pennyDoc.amount).toBe(148);
    expect(pennyDoc.type).toBe("Receipt");
    expect(pennyDoc.txnId).toBe("txn-penny");
    expect(pennyDoc.path).toBe(
      "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-09_PennyCaulfield_£148.00.pdf",
    );
    const filed = join(
      DATA_DIR,
      "Documents/Receipts/2026/2026-10/2026-10-09_PennyCaulfield_£148.00.pdf",
    );
    expect(existsSync(filed)).toBe(true);
    expect(readFileSync(filed).equals(PDF_BYTES)).toBe(true);
  });

  it("is carried by the snapshot, findable by transaction", () => {
    const snap = snapshotServer.buildSnapshot();
    const found = docFor("txn-penny", snap.docs);
    expect(found?.id).toBe(pennyDoc.id);
    expect(found?.path).toBe(pennyDoc.path);
    expect(isMatched(found!)).toBe(true);
  });

  it("serves the stored bytes with the right content type", async () => {
    const res = await api.handleChitraguptaApi(
      new Request(`http://local/api/documents/${pennyDoc.id}/file`),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/pdf");
    expect(res?.headers.get("content-disposition")).toContain("inline");
    const served = Buffer.from(await res!.arrayBuffer());
    expect(served.equals(PDF_BYTES)).toBe(true);
  });

  it("serves an uploaded image as an image", async () => {
    const res = await postDocument({
      filename: "boiler.png",
      contentBase64: PNG_BYTES.toString("base64"),
      type: "Warranty",
      merchant: "Boiler Service",
      date: "2026-09-15",
      amount: 220,
      warrantyEnds: "Sep 2028",
    });
    const body = (await res.json()) as { ok: boolean; document: Doc };
    expect(body.ok).toBe(true);
    expect(body.document.path).toBe(
      "PersonalFinance/Documents/Warranties/2026/2026-09/2026-09-15_BoilerService_£220.00.png",
    );
    expect(body.document.warrantyEnds).toBe("Sep 2028");
    const fileRes = await api.handleChitraguptaApi(
      new Request(`http://local/api/documents/${body.document.id}/file`),
    );
    expect(fileRes?.headers.get("content-type")).toBe("image/png");
    const served = Buffer.from(await fileRes!.arrayBuffer());
    expect(served.equals(PNG_BYTES)).toBe(true);
  });

  it("does not create a second record for an identical re-upload", async () => {
    const res = await postDocument(pennyPayload);
    const body = (await res.json()) as { ok: boolean; document: Doc };
    expect(body.ok).toBe(true);
    expect(body.document.id).toBe(pennyDoc.id);
    const snap = snapshotServer.buildSnapshot();
    expect(snap.docs.filter((d) => d.path === pennyDoc.path)).toHaveLength(1);
  });

  it("detach leaves the record listed and unmatched", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/documents/detach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txnId: "txn-penny" }),
      }),
    );
    const body = (await res!.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const snap = snapshotServer.buildSnapshot();
    expect(docFor("txn-penny", snap.docs)).toBeUndefined();
    const retained = snap.docs.find((d) => d.id === pennyDoc.id);
    expect(retained).toBeDefined();
    expect(isMatched(retained!)).toBe(false);
    // The file itself is retained too.
    const fileRes = await api.handleChitraguptaApi(
      new Request(`http://local/api/documents/${pennyDoc.id}/file`),
    );
    expect(fileRes?.status).toBe(200);
  });

  it("rejects an invalid extension with ok:false and writes nothing", async () => {
    const res = await postDocument({
      ...pennyPayload,
      filename: "evil.exe",
      txnId: undefined,
    });
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(
      existsSync(
        join(
          DATA_DIR,
          "Documents/Receipts/2026/2026-10/2026-10-09_PennyCaulfield_£148.00.exe",
        ),
      ),
    ).toBe(false);
  });

  it("rejects an oversize file with ok:false", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const res = await postDocument({
      filename: "big.pdf",
      contentBase64: big.toString("base64"),
      type: "Receipt",
      merchant: "Big Shop",
      date: "2026-10-10",
      amount: 10,
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    const snap = snapshotServer.buildSnapshot();
    expect(snap.docs.some((d) => d.merchant === "Big Shop")).toBe(false);
  });

  it("404s the file endpoint for an unknown document", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/documents/no-such-id/file"),
    );
    expect(res?.status).toBe(404);
    const body = (await res!.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
