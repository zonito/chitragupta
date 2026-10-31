import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { usePerson, PageTitle, Panel, Chip, meta } from "@/components/shell";
import { ACCOUNTS, gbp, ownerName } from "@/lib/data";
import { AccountTile } from "@/components/tiles";

export const Route = createFileRoute("/import")({
  head: () => meta("Import", "Statement status for each account and a place to drop new statements."),
  component: Import,
});

type IngestResult = {
  account: string;
  rowsAdded: number;
  ok?: boolean;
  file?: string | null;
  error?: string;
};

type IngestStatusAccount = {
  account: string;
  lastIngest: string;
  rowsSeen: number;
  rowsAdded: number;
  balanceMinor: number | null;
  currency: string | null;
  discrepancy: string | null;
};

/** Raw ingest account name → the snapshot's display label for it. */
const STATUS_LABEL: Record<string, string> = {
  Main: "Revolut Main",
  Pro: "Revolut Pro",
  "USD-Invest": "Revolut USD-Invest",
  Joint: "Joint Bills",
  "Savings-9000000002": "Revolut Savings 0002",
  "Savings-9000000001": "Revolut Savings 0001",
};

function formatBalance(balanceMinor: number, currency: string | null): string {
  const amount = balanceMinor / 100;
  if (!currency || currency === "GBP") return gbp(amount);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function Import() {
  const { person } = usePerson();
  const router = useRouter();
  const [file, setFile] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [statusAccounts, setStatusAccounts] = useState<IngestStatusAccount[]>([]);
  const list = ACCOUNTS.filter((a) => person === "household" || a.owner === person || a.owner === "joint");
  const stale = list.find((a) => a.stale);

  // Per-account balance and discrepancy come from the ingest status
  // endpoint (the latest recorded run per account, failures included),
  // fetched on mount and refreshed after every import run.
  const loadStatus = async () => {
    try {
      const res = await fetch("/api/ingest/status");
      const body = (await res.json()) as {
        ok: boolean;
        accounts?: IngestStatusAccount[];
      };
      if (body.ok && Array.isArray(body.accounts)) {
        setStatusAccounts(body.accounts);
      }
    } catch {
      // Status is supplementary: a failed fetch leaves the rows as they
      // were rather than breaking the screen.
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const statusByName = new Map<string, IngestStatusAccount>();
  for (const s of statusAccounts) {
    statusByName.set(s.account, s);
    const label = STATUS_LABEL[s.account];
    if (label) statusByName.set(label, s);
  }

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
      const results = body.results ?? [];
      const failed = results.filter((r) => r.ok === false);
      if (results.length > 0 && (failed.length > 0 || !body.ok)) {
        // Partial failure: the other accounts DID run, so say so, name
        // the failures from the per-account results, and refresh so the
        // successful accounts' updates show without a manual reload.
        const added = results.reduce((s, r) => s + (r.rowsAdded ?? 0), 0);
        const failedText =
          failed.length > 0
            ? failed
                .map(
                  (r) =>
                    `${r.account}${r.file ? ` (${r.file})` : ""}: ${r.error ?? "failed"}`,
                )
                .join(", ")
            : (body.error ?? "unknown error");
        setResult(
          `Import finished with errors — ${added} new rows across ${results.length} accounts; failed: ${failedText}`,
        );
        await router?.invalidate().catch(() => {});
        await loadStatus();
      } else if (body.ok) {
        const added = results.reduce((s, r) => s + (r.rowsAdded ?? 0), 0);
        setResult(`Import finished — ${added} new rows across ${results.length} accounts.`);
        await router?.invalidate().catch(() => {});
        await loadStatus();
      } else {
        setResult(`Import did not run: ${body.error ?? "unknown error"}`);
        await loadStatus();
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
        {list.length === 0 && (
          <p className="py-6 text-center text-body text-muted-foreground">No accounts yet — accounts appear here once statements have been imported.</p>
        )}
        {list.map((a) => {
          const status = statusByName.get(a.name);
          return (
            <div key={a.name} className="ledger-row flex items-center justify-between gap-2 py-3.5">
              <div className="flex min-w-0 items-center gap-2">
                <AccountTile account={a.name} />
                <div className="min-w-0">
                <div className="text-body">{a.name}</div>
                <div className="text-caption text-muted-foreground">{ownerName(a.owner)} · last upload {a.last} · {a.added} added</div>
                {status && status.balanceMinor !== null && status.balanceMinor !== undefined && (
                  <div className="num text-caption text-muted-foreground">Balance {formatBalance(status.balanceMinor, status.currency)}</div>
                )}
                {status?.discrepancy && (
                  <div className="text-caption text-warn">{status.discrepancy}</div>
                )}
                </div>
              </div>
              <Chip tone={a.stale ? "warn" : "good"}>{a.stale ? "Stale" : "Up to date"}</Chip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
