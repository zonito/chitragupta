import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Paperclip, Upload, X } from "lucide-react";
import { usePerson, PageTitle, CategoryChip, Sheet, Label, meta } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { DocumentPreview, useDocuments } from "@/components/documents";
import { MerchantTile, AccountTile } from "@/components/tiles";
import { ACCOUNTS, ALL_TXNS, categoryNames, docFor, docName, shareOf, gbp, dayLabel, ownerName, monthOptions, currentMonthKey, txnsInMonth, type Txn, type Category } from "@/lib/data";
import { fetchApiTransactions } from "@/lib/txn-map";

export const Route = createFileRoute("/activity")({
  head: () => meta("Activity", "Every transaction this month, grouped by day, with search and filters."),
  // Account scope, carried from the Cards screen's account cards:
  // ?account=<store account>&accountPerson=<store person>. It is a
  // real filter (not a view the global switch already fixes), so it
  // stays visible as a chip while active.
  validateSearch: (search: Record<string, unknown>) => ({
    account: typeof search["account"] === "string" ? search["account"] : undefined,
    accountPerson:
      typeof search["accountPerson"] === "string" ? search["accountPerson"] : undefined,
  }),
  component: Activity,
});

/** The store person a transaction's rows are filed under: Joint rows
 * live under Zonito's person in the store. */
const storePersonOf = (t: Txn): string => (t.owner === "joint" ? "zonito" : t.owner);

const sel = "rounded-lg border bg-card px-3 py-1.5 text-body";

export function Activity() {
  const { person } = usePerson();
  const { documents } = useDocuments();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [who, setWho] = useState("all");
  const [cat, setCat] = useState("all");
  const [month, setMonth] = useState(() => currentMonthKey());
  const [open, setOpen] = useState<Txn | null>(null);
  // Account scope from the URL (set by the Cards account cards). Read
  // once at mount — in-app navigation to /activity remounts the route —
  // then held in state so the chip can clear it in place.
  const [accountScope, setAccountScope] = useState<{
    account: string;
    person: string;
  } | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const account = params.get("account");
    const person = params.get("accountPerson");
    return account && person ? { account, person } : null;
  });
  const clearAccountScope = () => {
    setAccountScope(null);
    // Strip the query so a reload does not resurrect the scope.
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };
  const scopeLabel = accountScope
    ? (ACCOUNTS.find(
        (a) => a.person === accountScope.person && a.accountId === accountScope.account,
      )?.name ?? accountScope.account)
    : null;
  // Category correction in flight from the detail sheet: the value the
  // user just picked (shown until the refreshed data lands) and the
  // inline error when the save fails and the select reverts.
  const [catPick, setCatPick] = useState<Category | null>(null);
  const [catError, setCatError] = useState<string | null>(null);
  const [catBusy, setCatBusy] = useState(false);
  // The snapshot carries two months of rows; older months are fetched
  // from /api/transactions on first use and cached for the session.
  const [fetchedMonths, setFetchedMonths] = useState<Record<string, Txn[]>>({});

  const snapshotMonthKeys = useMemo(() => new Set(ALL_TXNS.map((t) => t.monthKey)), []);
  const inSnapshot = snapshotMonthKeys.has(month);
  // The fetched-month cache is keyed by month AND account scope: a
  // scoped fetch returns only that account's rows (the server filters
  // before LIMIT), so it must never stand in for the whole month once
  // the scope clears.
  const scopeCacheKey = accountScope
    ? `${accountScope.person}:${accountScope.account}`
    : "all";
  const monthCacheKey = `${month}|${scopeCacheKey}`;
  const monthLoaded = inSnapshot || monthCacheKey in fetchedMonths;
  const monthTxns = inSnapshot ? txnsInMonth(month) : (fetchedMonths[monthCacheKey] ?? []);

  useEffect(() => {
    if (inSnapshot || monthCacheKey in fetchedMonths) return;
    let cancelled = false;
    // Unscoped: no person parameter — fetch the whole month, then the
    // same shareOf / who filtering below applies, exactly as snapshot
    // months. Scoped: person + account go to the server so its filter
    // runs before LIMIT and the account's rows are never truncated
    // away by the rest of the month.
    fetchApiTransactions(
      accountScope
        ? {
            month,
            person: accountScope.person,
            account: accountScope.account,
            limit: "1000",
          }
        : { month, limit: "1000" },
    )
      .then((rows) => {
        if (!cancelled) setFetchedMonths((prev) => ({ ...prev, [monthCacheKey]: rows }));
      })
      .catch(() => {
        if (!cancelled) setFetchedMonths((prev) => ({ ...prev, [monthCacheKey]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [month, inSnapshot, fetchedMonths, monthCacheKey, accountScope]);

  // The account scope as a row predicate: snapshot months filter
  // client-side; fetched months arrive pre-filtered and pass through
  // the same predicate, so one rule governs both sources.
  const scopedMonthTxns = useMemo(
    () =>
      accountScope
        ? monthTxns.filter(
            (t) =>
              t.accountId === accountScope.account &&
              storePersonOf(t) === accountScope.person,
          )
        : monthTxns,
    [monthTxns, accountScope],
  );

  const monthSpend = scopedMonthTxns
    .filter((t) => t.kind === "spend")
    .reduce((s, t) => s + shareOf(t, person), 0);

  // The person dropdown is a Household-view filter only. A single-
  // person view is already scoped by the global switch, so the local
  // selection is ignored there: a leftover household-era choice must
  // never silently narrow (or empty) that person's list.
  const whoActive = person === "household" ? who : "all";

  const list = useMemo(
    () =>
      scopedMonthTxns
        .filter((t) => shareOf(t, person) > 0)
        .filter((t) => whoActive === "all" || t.owner === whoActive)
        .filter((t) => cat === "all" || t.category === cat)
        .filter((t) => t.merchant.toLowerCase().includes(q.toLowerCase()))
        // Newest first by full date. The sort is stable, so rows within
        // a day keep their source order — and both month sources
        // (snapshot builder and /api/transactions) produce their rows
        // newest-first within the day, so the two agree.
        .sort((a, b) => b.date.localeCompare(a.date)),
    [person, q, whoActive, cat, scopedMonthTxns],
  );
  const days = [...new Set(list.map((t) => t.day))];

  // The sheet renders the freshest copy of the opened transaction, so a
  // saved correction (which refreshes the snapshot and any fetched month)
  // shows in place instead of the stale object captured on tap.
  const openTxn = open
    ? (scopedMonthTxns.find((t) => t.id === open.id) ?? open)
    : null;

  const saveCategory = async (txn: Txn, category: Category) => {
    setCatPick(category);
    setCatError(null);
    setCatBusy(true);
    try {
      // txn.merchant is the store merchant string, the same value every
      // other screen keys on — never a display-trimmed variant.
      const res = await fetch("/api/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchant: txn.merchant,
          category,
          source: "user",
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
      } | null;
      if (!res.ok || !body?.ok) throw new Error("save failed");
      // Refresh the snapshot so every row of this merchant reflects the
      // correction without a manual reload, and drop this month's
      // on-demand cache (older months) so it refetches the same way.
      await router.invalidate();
      setFetchedMonths((prev) => {
        if (!(monthCacheKey in prev)) return prev;
        const next = { ...prev };
        delete next[monthCacheKey];
        return next;
      });
      setCatPick(null);
    } catch {
      setCatError("Could not save that category — it has been put back.");
      setCatPick(null);
    }
    setCatBusy(false);
  };

  // "New category…" in the sheet's dropdown: create the category
  // first (POST /api/categories), then apply it through the usual
  // correction flow, so re-filing, aside promotion and ingest learning
  // work for customs exactly as for built-ins. The refreshed snapshot
  // brings the new category (and its colour) to every surface.
  const createAndApplyCategory = async (txn: Txn) => {
    const name = window.prompt("New category name")?.trim();
    if (!name) return;
    setCatError(null);
    setCatBusy(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        category?: { name: string };
      } | null;
      if (!res.ok || !body?.ok || !body.category) {
        throw new Error(body?.error ?? "create failed");
      }
      await saveCategory(txn, body.category.name as Category);
    } catch (error) {
      setCatError(
        error instanceof Error && error.message !== "create failed"
          ? `Could not create that category — ${error.message}.`
          : "Could not create that category — it has been put back.",
      );
      setCatBusy(false);
    }
  };

  return (
    <div className="lg:max-w-3xl">
      <PageTitle sub={`${gbp(monthSpend)} spent · transfers and savings not counted`}>Activity</PageTitle>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merchants" className="w-full rounded-xl border bg-card py-2.5 pl-9 pr-4 text-body outline-none focus:ring-2 focus:ring-ring" />
      </div>
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {/* The account scope (from a Cards account card) is a real
            filter, so — unlike the person dropdown below — it stays
            visible in every view while active, with its own clear
            control. */}
        {accountScope && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card py-1 pl-3 pr-1.5 text-body">
            {scopeLabel}
            <button
              type="button"
              aria-label="Clear account filter"
              onClick={clearAccountScope}
              className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        )}
        {/* A filter whose value the global view already fixes is not
            shown: the person dropdown exists only in Household view. */}
        {person === "household" && (
          <select className={sel} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
            <option value="all">Anyone</option><option value="zonito">Zonito</option><option value="nikhila">Nikhila</option><option value="joint">Joint</option>
          </select>
        )}
        <select className={sel} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {[...categoryNames(), "Transfer", "Moved aside"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={sel} value={month} onChange={(e) => setMonth(e.target.value)}>
          {monthOptions().map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      {days.length === 0 && <p className="py-12 text-center text-body text-muted-foreground">{monthLoaded ? "Nothing here." : "Loading…"}</p>}
      {days.map((d) => (
        <div key={d} className="mb-5">
          <Label>{dayLabel(d, false, month)}</Label>
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

      <Sheet
        open={!!open}
        onClose={() => {
          setOpen(null);
          setCatPick(null);
          setCatError(null);
        }}
      >
        {openTxn && (
          <div>
            <div className="text-body text-muted-foreground">{openTxn.merchant}</div>
            <div className="mb-5">
              <div className="num text-title font-semibold">{gbp(shareOf(openTxn, person))}</div>
              {openTxn.owner === "joint" && person !== "household" && <p className="num mt-1 text-caption text-muted-foreground">Full bill {gbp(openTxn.amount)}</p>}
            </div>
            <dl className="text-body">
              {[
                ["Date", dayLabel(openTxn.day, true, openTxn.monthKey)],
                ["Account", openTxn.account],
                ["Who", ownerName(openTxn.owner)],
                ...(openTxn.fx ? [["Original", openTxn.fx]] : []),
                ...(openTxn.note ? [["Note", openTxn.note]] : []),
              ].map(([k, v]) => (
                <div key={k} className="ledger-row flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">{k}</dt><dd className="flex min-w-0 items-center gap-2 break-all text-right">{k === "Account" && <AccountTile account={openTxn.account} />}{v}</dd></div>
              ))}
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">Category</dt>
                <select
                  className={sel}
                  value={catPick ?? openTxn.category}
                  disabled={catBusy}
                  onChange={(e) => {
                    if (e.target.value === "__new__") {
                      void createAndApplyCategory(openTxn);
                    } else {
                      void saveCategory(openTxn, e.target.value as Category);
                    }
                  }}
                >
                  {[...categoryNames(), "Transfer", "Moved aside"].map((c) => <option key={c}>{c}</option>)}
                  <option value="__new__">New category…</option>
                </select>
              </div>
            </dl>
            {catError && <p className="mt-2 text-caption text-destructive" role="alert">{catError}</p>}
            {openTxn.kind === "transfer" && <p className="mt-3 text-caption text-muted-foreground">Between Zonito and Nikhila — never counted as spending.</p>}
            <TransactionReceipt key={openTxn.id} transaction={openTxn} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

function TransactionReceipt({ transaction }: { transaction: Txn }) {
  const { documents, attach, remove } = useDocuments();
  const router = useRouter();
  const receipt = docFor(transaction.id, documents);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      // The file's real bytes are uploaded and filed by the server;
      // the paperclip state below is the persisted record it returns.
      await attach(transaction, file);
      setPreview(false);
      await router?.invalidate().catch(() => {});
    } catch {
      setError("Could not attach that file — please try again.");
    }
    setBusy(false);
  };
  const onRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await remove(transaction.id);
      setPreview(false);
      await router?.invalidate().catch(() => {});
    } catch {
      setError("Could not remove that receipt — please try again.");
    }
    setBusy(false);
  };
  return (
    <section className="mt-5 border-t pt-4">
      <Label>Receipt</Label>
      {receipt ? (
        <>
          <p className="break-all text-body">{docName(receipt)}</p>
          <p className="mt-1 break-all text-caption text-muted-foreground">{receipt.path}</p>
          <div className="mt-2 flex gap-1">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPreview(!preview)}>View</Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => input.current?.click()}>Replace</Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => void onRemove()}>Remove</Button>
          </div>
          {preview && <div className="mt-3"><DocumentPreview doc={receipt} /></div>}
        </>
      ) : (
        <>
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}><Upload />{busy ? "Attaching…" : "Add receipt"}</Button>
          <p className="mt-2 text-caption text-muted-foreground">Files itself in Drive under PersonalFinance/Documents, matched to this transaction.</p>
        </>
      )}
      {error && <p className="mt-2 text-caption text-destructive" role="alert">{error}</p>}
      <input ref={input} type="file" aria-label="Receipt file" accept="image/*,application/pdf" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        void onFile(file);
      }} />
    </section>
  );
}
