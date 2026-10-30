import { TXNS, DOCS, shareOf, isMatched, dateLabel, type Doc, type Person, type Txn } from "@/lib/data";

const STOP_WORDS = new Set("when did do does we i our my your the a an last latest get got has have was were is it been for from on in at to of and how much find show me please end ends expire expires expiration expiry buy bought purchase purchased pay paid cost so far this month about".split(" "));
const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stem = (word: string) => /^(service|serviced|servicing)$/.test(word) ? "service" : /^(warranty|warranties)$/.test(word) ? "warranty" : word;
const words = (text: string) => normalise(text).split(/\s+/).map(stem);

/** The content terms a question reduces to (stop-words removed, stemmed). */
export function questionTerms(question: string): string[] {
  return words(question).filter((word) => word && !STOP_WORDS.has(word));
}

export type RecordMatch = {
  id: string;
  merchant: string;
  date: string;
  timestamp: number;
  amount: number;
  transaction?: Txn;
  document?: Doc;
};

/** Search only recorded metadata, never infer an unrecorded purchase or service. */
export function searchRecords(question: string, person: Person, documents: readonly Doc[] = DOCS, transactions: readonly Txn[] = TXNS) {
  const terms = questionTerms(question);
  const matches = (text: string) => {
    const haystack = words(text);
    return terms.length > 0 && terms.every((term) => haystack.some((word) => word === term));
  };
  const visibleTransactions = transactions.filter((txn) => shareOf(txn, person) > 0);
  const visibleDocuments = documents.filter((doc) => {
    if (person === "household") return true;
    const owner = transactions.find((txn) => txn.id === doc.txnId)?.owner ?? (isMatched(doc) ? doc.owner : undefined);
    return owner === person || owner === "joint";
  });
  const results: RecordMatch[] = [];
  const addedDocs = new Set<string>();
  for (const txn of visibleTransactions) {
    const attached = visibleDocuments.filter((doc) => doc.txnId === txn.id);
    const matchingDocs = attached.filter((doc) => matches(`${doc.merchant} ${doc.type} ${doc.matchedLine ?? ""} ${doc.path}`));
    if (!matches(`${txn.merchant} ${txn.category} ${txn.note ?? ""}`) && !matchingDocs.length) continue;
    const linked = matchingDocs.length ? matchingDocs : attached;
    for (const doc of linked) addedDocs.add(doc.id);
    // A linked document and its payment are one record, not two separate purchases.
    // The transaction's own month + day is its position; for store-built rows
    // that always equals txn.date.
    const iso = `${txn.monthKey}-${String(txn.day).padStart(2, "0")}`;
    const base = { merchant: txn.merchant, date: dateLabel(iso), timestamp: Date.parse(`${iso}T00:00:00Z`), amount: shareOf(txn, person), transaction: txn };
    if (linked.length) for (const document of linked) results.push({ ...base, id: `${txn.id}-${document.id}`, document });
    else results.push({ ...base, id: `txn-${txn.id}` });
  }
  for (const doc of visibleDocuments) {
    if (addedDocs.has(doc.id) || !matches(`${doc.merchant} ${doc.type} ${doc.matchedLine ?? ""} ${doc.path}`)) continue;
    results.push({ id: `doc-${doc.id}`, merchant: doc.merchant, date: doc.date, timestamp: Date.parse(`${doc.date} UTC`), amount: doc.amount, document: doc });
  }
  results.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  return { records: results, latest: results[0], warrantyQuestion: /warranty|warranties/i.test(question) && /end|expir/i.test(question) };
}