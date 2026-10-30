import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Upload } from "lucide-react";
import { usePerson, PageTitle, Panel, Chip, meta } from "@/components/shell";
import { ACCOUNTS, ownerName } from "@/lib/data";
import { AccountTile } from "@/components/tiles";

export const Route = createFileRoute("/import")({
  head: () => meta("Import", "Statement status for each account and a place to drop new statements."),
  component: Import,
});

type IngestResult = { account: string; rowsAdded: number };

function Import() {
  const { person } = usePerson();
  const router = useRouter();
  const [file, setFile] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const list = ACCOUNTS.filter((a) => person === "household" || a.owner === person || a.owner === "joint");
  const stale = list.find((a) => a.stale);

  // Import reads the synced PersonalFinance folder on the server (the
  // statements already live there via Drive); the drop zone is the trigger,
  // then the snapshot reloads so every screen shows the new figures.
  const runImport = async (name?: string | null) => {
    if (name) setFile(name);
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/ingest/run", { method: "POST" });
      const body = (await res.json()) as { ok: boolean; error?: string; results?: IngestResult[] };
      if (body.ok) {
        const results = body.results ?? [];
        const added = results.reduce((s, r) => s + (r.rowsAdded ?? 0), 0);
        setResult(`Import finished — ${added} new rows across ${results.length} accounts.`);
        await router.invalidate();
      } else {
        setResult(`Import did not run: ${body.error ?? "unknown error"}`);
      }
    } catch {
      setResult("Import did not run: the app server did not answer.");
    }
    setRunning(false);
  };

  return (
    <div className="lg:max-w-3xl">
      <PageTitle>Import</PageTitle>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void runImport(e.dataTransfer.files[0]?.name ?? null); }}
        className="mb-6 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center"
      >
        <Upload className="mb-3 h-6 w-6 text-primary" />
        <div className="text-body">{running ? "Importing…" : file ? `Last file: ${file}` : "Drop a statement here to import"}</div>
        <div className="mt-1 text-caption text-muted-foreground">Statements are read from the synced PersonalFinance folder; duplicates are skipped</div>
        <input type="file" className="hidden" onChange={(e) => { void runImport(e.target.files?.[0]?.name ?? null); }} />
      </label>
      {result && (
        <Panel className="mb-6 bg-secondary p-4 text-body" aria-live="polite">{result}</Panel>
      )}

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
