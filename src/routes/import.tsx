import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Upload } from "lucide-react";
import { usePerson, PageTitle, Panel, Chip, meta } from "@/components/shell";
import { ACCOUNTS, ownerName } from "@/lib/data";
import { AccountTile } from "@/components/tiles";

export const Route = createFileRoute("/import")({
  head: () => meta("Import", "Statement status for each account and a place to drop new statements."),
  component: Import,
});

function Import() {
  const { person } = usePerson();
  const [file, setFile] = useState<string | null>(null);
  const list = ACCOUNTS.filter((a) => person === "household" || a.owner === person || a.owner === "joint");
  const stale = list.find((a) => a.stale);
  return (
    <div className="lg:max-w-3xl">
      <PageTitle>Import</PageTitle>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]?.name ?? null); }}
        className="mb-6 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center"
      >
        <Upload className="mb-3 h-6 w-6 text-primary" />
        <div className="text-body">{file ? `Ready: ${file}` : "Drop a statement here"}</div>
        <div className="mt-1 text-caption text-muted-foreground">CSV or PDF · mockup only, nothing is uploaded</div>
        <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
      </label>

      {stale && (
        <Panel className="mb-6 bg-secondary p-4 text-body">
          {stale.name} hasn't had a statement since {stale.last}. Whenever you have a minute.
        </Panel>
      )}

      <div className="rounded-xl border bg-card px-4">
        {list.map((a) => (
          <div key={a.name} className="ledger-row flex items-center justify-between gap-2 py-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <AccountTile account={a.name} />
              <div className="min-w-0">
              <div className="text-body">{a.name}</div>
              <div className="text-caption text-muted-foreground">{ownerName(a.owner)} · last upload {a.last} · {a.added} added</div>
              </div>
            </div>
            <Chip tone={a.stale ? "warn" : "good"}>{a.stale ? "Stale" : "Up to date"}</Chip>
          </div>
        ))}
      </div>
    </div>
  );
}
