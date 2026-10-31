import { dateLabel, type Doc, type DocType } from "./data";

/**
 * Server-side document filing: the twin of receiptForTransaction in
 * data.ts. The naming convention is shared, never forked:
 *   Documents/<Type>s/<Year>/<YYYY-MM>/<YYYY-MM-DD>_<MerchantNoSpaces>_£<amount>.<ext>
 * stored relative to the data dir (the Drive-synced PersonalFinance
 * folder), so a file written here is genuinely filed in Drive. The
 * snapshot presents the same path prefixed with "PersonalFinance/".
 */

export const DOC_TYPES: readonly DocType[] = [
  "Receipt",
  "Bill",
  "Invoice",
  "Warranty",
];

export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "jpg",
  "jpeg",
  "png",
]);

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// "Warranty" pluralises to "Warranties" (see the filed sample paths);
// the rest are a plain trailing "s".
const PLURAL: Record<DocType, string> = {
  Receipt: "Receipts",
  Bill: "Bills",
  Invoice: "Invoices",
  Warranty: "Warranties",
};

export function documentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** The data-dir-relative filing path for a document, by convention. */
export function documentRelativePath(input: {
  type: DocType;
  date: string; // ISO YYYY-MM-DD
  merchant: string;
  amount: number; // pounds
  extension: string;
}): string {
  const year = input.date.slice(0, 4);
  const yearMonth = input.date.slice(0, 7);
  const merchant =
    input.merchant.replace(/[^\p{L}\p{N}]/gu, "") || "Receipt";
  return `Documents/${PLURAL[input.type]}/${year}/${yearMonth}/${input.date}_${merchant}_£${input.amount.toFixed(2)}.${input.extension}`;
}

export interface DocumentRow {
  id: string;
  merchant: string;
  date: string; // ISO YYYY-MM-DD
  amount_minor: number;
  type: string;
  txn_id: string | null;
  path: string; // relative to the data dir
  warranty_ends: string | null;
}

/** A stored row in the client's Doc shape (display date, pounds,
 *  "PersonalFinance/"-prefixed path), exactly as the snapshot serves it. */
export function documentRowToDoc(row: DocumentRow): Doc {
  const doc: Doc = {
    id: row.id,
    merchant: row.merchant,
    date: dateLabel(row.date),
    amount: row.amount_minor / 100,
    type: row.type as DocType,
    path: `PersonalFinance/${row.path}`,
  };
  if (row.txn_id) doc.txnId = row.txn_id;
  if (row.warranty_ends) doc.warrantyEnds = row.warranty_ends;
  return doc;
}

export function contentTypeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
