import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Upload } from "lucide-react";
import {
  PageTitle,
  Panel,
  Chip,
  Sheet,
  Label,
  meta,
  usePerson,
} from "@/components/shell";
import { Button } from "@/components/ui/button";
import {
  TXNS,
  gbp,
  dayLabel,
  isMatched,
  documentsFor,
  type Doc,
  type DocType,
} from "@/lib/data";
import { DocumentPreview, useDocuments } from "@/components/documents";

export const Route = createFileRoute("/receipts")({
  head: () =>
    meta(
      "Receipts & documents",
      "Receipts, bills, invoices and warranties, matched to transactions and filed in Drive.",
    ),
  component: Receipts,
});

function matchLine(d: Doc) {
  if (d.matchedLine) return d.matchedLine;
  const t = TXNS.find((x) => x.id === d.txnId);
  return t
    ? `${t.merchant} · ${dayLabel(t.day)} · ${t.account} · ${gbp(t.amount)}`
    : null;
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const field = "w-full rounded-lg border bg-card px-3 py-1.5 text-body";

export function Receipts() {
  const { person } = usePerson();
  const { documents, upload } = useDocuments();
  const router = useRouter();
  const [pending, setPending] = useState<File | null>(null);
  const [merchant, setMerchant] = useState("");
  const [docType, setDocType] = useState<DocType>("Receipt");
  const [docDate, setDocDate] = useState(todayIso);
  const [amount, setAmount] = useState("");
  const [warrantyEnds, setWarrantyEnds] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [open, setOpen] = useState<Doc | null>(null);

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setPending(file);
    setSaveError(null);
  };

  const save = async () => {
    if (!pending) return;
    const amountNumber = Number(amount);
    if (!merchant.trim() || !docDate || !Number.isFinite(amountNumber)) {
      setSaveError(
        "Add the merchant, date and amount so the document can be filed.",
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await upload({
        file: pending,
        type: docType,
        merchant: merchant.trim(),
        date: docDate,
        amount: amountNumber,
        ...(warrantyEnds.trim() ? { warrantyEnds: warrantyEnds.trim() } : {}),
      });
      setPending(null);
      setMerchant("");
      setDocType("Receipt");
      setDocDate(todayIso());
      setAmount("");
      setWarrantyEnds("");
      // Reload the snapshot so the list is the persisted set; the
      // provider resyncs from it (see DocumentsProvider).
      await router?.invalidate().catch(() => {});
    } catch {
      setSaveError("Could not save that document — please try again.");
    }
    setSaving(false);
  };

  return (
    <div className="lg:max-w-3xl">
      <PageTitle>Receipts & documents</PageTitle>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          chooseFile(e.dataTransfer.files[0]);
        }}
        className="mb-6 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center"
      >
        <Upload className="mb-3 h-6 w-6 text-primary" />
        <div className="text-body">
          {pending ? pending.name : "Drop a receipt or bill here"}
        </div>
        <div className="mt-1 text-caption text-muted-foreground">
          Photo or PDF · filed in Drive under PersonalFinance/Documents
        </div>
        <input
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            chooseFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>

      {pending && (
        <div className="mb-6 rounded-xl border bg-card p-4">
          <Label>File this document</Label>
          <div className="grid gap-3">
            <label className="text-caption text-muted-foreground">
              Merchant
              <input
                aria-label="Merchant"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                className={field}
              />
            </label>
            <label className="text-caption text-muted-foreground">
              Type
              <select
                aria-label="Document type"
                value={docType}
                onChange={(e) => setDocType(e.target.value as DocType)}
                className={field}
              >
                <option>Receipt</option>
                <option>Bill</option>
                <option>Invoice</option>
                <option>Warranty</option>
              </select>
            </label>
            <label className="text-caption text-muted-foreground">
              Date
              <input
                aria-label="Document date"
                type="date"
                value={docDate}
                onChange={(e) => setDocDate(e.target.value)}
                className={field}
              />
            </label>
            <label className="text-caption text-muted-foreground">
              Amount (£)
              <input
                aria-label="Amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={field}
              />
            </label>
            <label className="text-caption text-muted-foreground">
              Warranty end (optional)
              <input
                aria-label="Warranty end"
                value={warrantyEnds}
                onChange={(e) => setWarrantyEnds(e.target.value)}
                placeholder="e.g. Mar 2028"
                className={field}
              />
            </label>
          </div>
          {saveError && (
            <p className="mt-2 text-caption text-destructive" role="alert">
              {saveError}
            </p>
          )}
          <div className="mt-3 flex gap-1">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save document"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setSaveError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <Label>Documents</Label>
      <div className="mb-6 rounded-xl border bg-card px-4">
        {documentsFor(documents, person).length === 0 && (
          <p className="py-6 text-center text-body text-muted-foreground">
            No documents filed yet. Receipts and bills you attach appear here.
          </p>
        )}
        {documentsFor(documents, person).map((d) => (
          <button
            key={d.id}
            onClick={() => setOpen(d)}
            className="ledger-row flex w-full items-start justify-between gap-3 py-3 text-left"
          >
            <div className="min-w-0">
              <div className="truncate text-body">{d.merchant}</div>
              <div className="text-caption text-muted-foreground">{d.date}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Chip>{d.type}</Chip>
                <Chip tone={isMatched(d) ? "good" : "warn"}>
                  {isMatched(d) ? "Matched" : "Not matched"}
                </Chip>
              </div>
              <div className="mt-1.5 text-caption text-muted-foreground">
                Filed in Drive
              </div>
            </div>
            <span className="num shrink-0">{gbp(d.amount)}</span>
          </button>
        ))}
      </div>

      <Panel className="bg-secondary p-4 text-body">
        Files live in Drive under PersonalFinance/Documents, filed by type, year
        and month. Ask can find them later.
      </Panel>

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div>
            <div className="mb-5">
              <DocumentPreview doc={open} />
            </div>
            <dl className="text-body">
              {[
                ["Merchant", open.merchant],
                ["Date", open.date],
                ["Amount", gbp(open.amount)],
                ["Type", open.type],
                ...(open.warrantyEnds
                  ? [["Warranty ends", open.warrantyEnds]]
                  : []),
                ["Matched to", matchLine(open) ?? "Not matched yet"],
                ["Filed at", open.path],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="ledger-row flex justify-between gap-4 py-2.5"
                >
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd
                    className={`num min-w-0 text-right ${k === "Filed at" ? "break-all text-caption text-muted-foreground" : ""}`}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </Sheet>
    </div>
  );
}
