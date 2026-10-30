import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FileText, Upload } from "lucide-react";
import { PageTitle, Panel, Chip, Sheet, Label, meta, usePerson } from "@/components/shell";
import { TXNS, gbp, dayLabel, isMatched, documentsFor, type Doc } from "@/lib/data";
import { useDocuments } from "@/components/documents";

export const Route = createFileRoute("/receipts")({
  head: () => meta("Receipts & documents", "Receipts, bills, invoices and warranties, matched to transactions and filed in Drive."),
  component: Receipts,
});

function matchLine(d: Doc) {
  if (d.matchedLine) return d.matchedLine;
  const t = TXNS.find((x) => x.id === d.txnId);
  return t ? `${t.merchant} · ${dayLabel(t.day)} · ${t.account} · ${gbp(t.amount)}` : null;
}

function Receipts() {
  const { person } = usePerson();
  const { documents } = useDocuments();
  const [file, setFile] = useState<string | null>(null);
  const [open, setOpen] = useState<Doc | null>(null);
  return (
    <div className="lg:max-w-3xl">
      <PageTitle>Receipts & documents</PageTitle>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]?.name ?? null); }}
        className="mb-6 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center"
      >
        <Upload className="mb-3 h-6 w-6 text-primary" />
        <div className="text-body">{file ? `Ready: ${file}` : "Drop a receipt or bill here"}</div>
        <div className="mt-1 text-caption text-muted-foreground">Photo or PDF · filed in Drive under PersonalFinance/Documents</div>
        <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
      </label>

      <Label>Documents</Label>
      <div className="mb-6 rounded-xl border bg-card px-4">
        {documentsFor(documents, person).length === 0 && (
          <p className="py-6 text-center text-body text-muted-foreground">No documents filed yet. Receipts and bills you attach appear here.</p>
        )}
        {documentsFor(documents, person).map((d) => (
          <button key={d.id} onClick={() => setOpen(d)} className="ledger-row flex w-full items-start justify-between gap-3 py-3 text-left">
            <div className="min-w-0">
              <div className="truncate text-body">{d.merchant}</div>
              <div className="text-caption text-muted-foreground">{d.date}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Chip>{d.type}</Chip>
                <Chip tone={isMatched(d) ? "good" : "warn"}>{isMatched(d) ? "Matched" : "Not matched"}</Chip>
              </div>
              <div className="mt-1.5 text-caption text-muted-foreground">Filed in Drive</div>
            </div>
            <span className="num shrink-0">{gbp(d.amount)}</span>
          </button>
        ))}
      </div>

      <Panel className="bg-secondary p-4 text-body">
        Files live in Drive under PersonalFinance/Documents, filed by type, year and month. Ask can find them later.
      </Panel>

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div>
            <div className="mb-5 flex h-36 flex-col items-center justify-center rounded-xl border border-dashed bg-muted text-muted-foreground">
              <FileText className="mb-2 h-7 w-7" />
              <span className="text-caption">Document preview</span>
            </div>
            <dl className="text-body">
              {[
                ["Merchant", open.merchant],
                ["Date", open.date],
                ["Amount", gbp(open.amount)],
                ["Type", open.type],
                ...(open.warrantyEnds ? [["Warranty ends", open.warrantyEnds]] : []),
                ["Matched to", matchLine(open) ?? "Not matched yet"],
                ["Filed at", open.path],
              ].map(([k, v]) => (
                <div key={k} className="ledger-row flex justify-between gap-4 py-2.5">
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd className={`num min-w-0 text-right ${k === "Filed at" ? "break-all text-caption text-muted-foreground" : ""}`}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </Sheet>
    </div>
  );
}
