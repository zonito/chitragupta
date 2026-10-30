import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Search, Paperclip, Upload, FileText } from "lucide-react";
import { usePerson, PageTitle, CategoryChip, Sheet, Label, meta } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { useDocuments } from "@/components/documents";
import { MerchantTile, AccountTile } from "@/components/tiles";
import { TXNS, CATEGORIES, docFor, docName, shareOf, spendTotal, gbp, dayLabel, ownerName, type Txn, type Category } from "@/lib/data";

export const Route = createFileRoute("/activity")({
  head: () => meta("Activity", "Every transaction this month, grouped by day, with search and filters."),
  component: Activity,
});

const sel = "rounded-lg border bg-card px-3 py-1.5 text-body";

function Activity() {
  const { person } = usePerson();
  const { documents } = useDocuments();
  const [q, setQ] = useState("");
  const [who, setWho] = useState("all");
  const [cat, setCat] = useState("all");
  const [month, setMonth] = useState("oct");
  const [open, setOpen] = useState<Txn | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Category>>({});

  const list = useMemo(
    () =>
      month !== "oct"
        ? []
        : TXNS.map((t) => ({ ...t, category: overrides[t.id] ?? t.category }))
            .filter((t) => shareOf(t, person) > 0)
            .filter((t) => who === "all" || t.owner === who)
            .filter((t) => cat === "all" || t.category === cat)
            .filter((t) => t.merchant.toLowerCase().includes(q.toLowerCase()))
            .sort((a, b) => b.day - a.day),
    [person, q, who, cat, month, overrides],
  );
  const days = [...new Set(list.map((t) => t.day))];

  return (
    <div className="lg:max-w-3xl">
      <PageTitle sub={`${gbp(spendTotal(person))} spent · transfers and savings not counted`}>Activity</PageTitle>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merchants" className="w-full rounded-xl border bg-card py-2.5 pl-9 pr-4 text-body outline-none focus:ring-2 focus:ring-ring" />
      </div>
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        <select className={sel} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">Anyone</option><option value="zonito">Zonito</option><option value="nikhila">Nikhila</option><option value="joint">Joint</option>
        </select>
        <select className={sel} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {[...CATEGORIES, "Transfer", "Moved aside"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={sel} value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="oct">October 2026</option><option value="sep">September 2026</option>
        </select>
      </div>

      {days.length === 0 && <p className="py-12 text-center text-body text-muted-foreground">Nothing here. {month !== "oct" && "September isn't loaded in this mockup."}</p>}
      {days.map((d) => (
        <div key={d} className="mb-5">
          <Label>{dayLabel(d)}</Label>
          <div className="rounded-xl border bg-card px-4">
            {list.filter((t) => t.day === d).map((t) => (
              <button key={t.id} onClick={() => setOpen(t)} className="ledger-row flex w-full items-center justify-between gap-3 py-3 text-left">
                <div className="flex min-w-0 items-center gap-2">
                  <MerchantTile merchant={t.merchant} category={t.category} />
                  <div className="min-w-0">
                  <div className="truncate text-body">{t.merchant}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <CategoryChip category={t.category} />
                    {person === "household" && <span className="text-caption text-muted-foreground">{ownerName(t.owner)}</span>}
                  </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {docFor(t.id, documents) && <Paperclip aria-label="Receipt attached" className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="num text-body font-medium text-foreground">{gbp(shareOf(t, person))}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div className="max-h-[75vh] overflow-y-auto">
            <div className="text-body text-muted-foreground">{open.merchant}</div>
            <div className="mb-5">
              <div className="num text-title font-semibold">{gbp(shareOf(open, person))}</div>
              {open.owner === "joint" && person !== "household" && <p className="num mt-1 text-caption text-muted-foreground">Full bill {gbp(open.amount)}</p>}
            </div>
            <dl className="text-body">
              {[
                ["Date", dayLabel(open.day, true)],
                ["Account", open.account],
                ["Who", ownerName(open.owner)],
                ...(open.fx ? [["Original", open.fx]] : []),
                ...(open.note ? [["Note", open.note]] : []),
              ].map(([k, v]) => (
                <div key={k} className="ledger-row flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">{k}</dt><dd className="flex min-w-0 items-center gap-2 break-all text-right">{k === "Account" && <AccountTile account={open.account} />}{v}</dd></div>
              ))}
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">Category</dt>
                <select
                  className={sel}
                  value={overrides[open.id] ?? open.category}
                  onChange={(e) => setOverrides({ ...overrides, [open.id]: e.target.value as Category })}
                >
                  {[...CATEGORIES, "Transfer", "Moved aside"].map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </dl>
            {open.kind === "transfer" && <p className="mt-3 text-caption text-muted-foreground">Between Zonito and Nikhila — never counted as spending.</p>}
            <TransactionReceipt key={open.id} transaction={open} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

function TransactionReceipt({ transaction }: { transaction: Txn }) {
  const { documents, attach, remove } = useDocuments();
  const receipt = docFor(transaction.id, documents);
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choose = (extension: "pdf" | "jpg" | "png" = "pdf") => {
    attach(transaction, extension);
    setChoosing(false);
    setPreview(false);
  };
  return (
    <section className="mt-5 border-t pt-4">
      <Label>Receipt</Label>
      {receipt ? (
        <>
          <p className="break-all text-body">{docName(receipt)}</p>
          <p className="mt-1 break-all text-caption text-muted-foreground">{receipt.path}</p>
          <div className="mt-2 flex gap-1">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setPreview(!preview); setChoosing(false); }}>View</Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setChoosing(true); setPreview(false); }}>Replace</Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { remove(transaction.id); setPreview(false); setChoosing(false); }}>Remove</Button>
          </div>
          {preview && <div className="mt-3 flex h-36 flex-col items-center justify-center rounded-xl border border-dashed bg-muted text-muted-foreground"><FileText className="mb-2 h-7 w-7" /><span className="text-caption">Document preview</span></div>}
        </>
      ) : (
        <>
          <Button variant="outline" onClick={() => setChoosing(true)}><Upload />Add receipt</Button>
          <p className="mt-2 text-caption text-muted-foreground">Files itself in Drive under PersonalFinance/Documents, matched to this transaction.</p>
        </>
      )}
      {choosing && (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-muted/40 p-4 text-center">
          <Upload className="h-5 w-5 text-muted-foreground" />
          <p className="text-caption text-muted-foreground">Photo or PDF · mock only, nothing is uploaded</p>
          <div className="flex flex-wrap justify-center gap-1">
            <Button variant="outline" size="sm" onClick={() => choose()}>Choose sample PDF</Button>
            <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>Choose photo / PDF</Button>
            <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <input ref={input} type="file" aria-label="Receipt file" accept="image/*,application/pdf" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return;
        choose(file.type === "image/png" ? "png" : file.type.startsWith("image/") ? "jpg" : "pdf");
        e.target.value = "";
      }} />
    </section>
  );
}
