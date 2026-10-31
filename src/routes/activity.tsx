import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Paperclip, Upload, X, StickyNote, Copy, Check } from "lucide-react";
import { usePerson, PageTitle, CategoryChip, Sheet, Label, meta } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { DocumentPreview, useDocuments } from "@/components/documents";
import { MerchantTile, AccountTile } from "@/components/tiles";
import { ACCOUNTS, ALL_TXNS, SUBS, SUB_OVERRIDES, categoryNames, docFor, docName, shareOf, gbp, dayLabel, dateLabel, ownerName, personLabel, monthOptions, currentMonthKey, txnsInMonth, type Txn, type Category } from "@/lib/data";
import { PERIOD_PRESETS, parsePreset, presetValue, rangeForPreset } from "@/lib/periods";
import { fetchApiTransactions } from "@/lib/txn-map";
import { canonicalMerchant } from "@/lib/subscriptions";
import { postSubscriptionOverride, type SubscriptionOverrideMode } from "@/lib/subscription-overrides";

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
  // The selected period: a month key ("2026-10") or a range preset
  // ("preset:last12" — This quarter / Year to date / Last 12 months,
  // anchored to the store's latest data month, not the wall clock).
  const [period, setPeriod] = useState<string>(() => currentMonthKey());
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
  const preset = parsePreset(period);
  const range = useMemo(
    () => (preset ? rangeForPreset(preset, currentMonthKey()) : null),
    [preset],
  );
  const inSnapshot = !range && snapshotMonthKeys.has(period);
  // The fetched-rows cache is keyed by period AND account scope: a
  // scoped fetch returns only that account's rows (the server filters
  // before LIMIT), so it must never stand in for the whole period once
  // the scope clears. Range presets fetch their whole range in one
  // from/to call under their own key.
  const scopeCacheKey = accountScope
    ? `${accountScope.person}:${accountScope.account}`
    : "all";
  const monthCacheKey = range
    ? `range:${range.from}..${range.to}|${scopeCacheKey}`
    : `${period}|${scopeCacheKey}`;
  const monthLoaded = inSnapshot || monthCacheKey in fetchedMonths;
  const monthTxns = useMemo(() => {
    if (!range) {
      return inSnapshot ? txnsInMonth(period) : (fetchedMonths[monthCacheKey] ?? []);
    }
    // Merge the snapshot months inside the range with the fetched
    // range rows, fingerprint-keyed: a month the snapshot already
    // carries never duplicates when the fetch returns it too.
    const byId = new Map<string, Txn>();
    for (const t of ALL_TXNS) {
      if (t.monthKey >= range.from && t.monthKey <= range.to) byId.set(t.id, t);
    }
    for (const t of fetchedMonths[monthCacheKey] ?? []) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
    return [...byId.values()];
  }, [range, inSnapshot, period, monthCacheKey, fetchedMonths]);

  useEffect(() => {
    if (inSnapshot || monthCacheKey in fetchedMonths) return;
    let cancelled = false;
    // Unscoped: no person parameter — fetch the whole period, then the
    // same shareOf / who filtering below applies, exactly as snapshot
    // months. Scoped: person + account go to the server so its filter
    // runs before LIMIT and the account's rows are never truncated
    // away by the rest of the period.
    const scopeParams = accountScope
      ? { person: accountScope.person, account: accountScope.account }
      : {};
    fetchApiTransactions(
      range
        ? { from: range.from, to: range.to, ...scopeParams, limit: "10000" }
        : { month: period, ...scopeParams, limit: "1000" },
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
  }, [period, range, inSnapshot, fetchedMonths, monthCacheKey, accountScope]);

  // Notes saved in this session, applied over both month sources so a
  // save reflects immediately (list indicator, sheet, search) without
  // waiting for the snapshot refresh the save also triggers.
  const [noteOverrides, setNoteOverrides] = useState<Record<string, string | null>>({});
  const applyNoteLocally = (id: string, note: string | null) => {
    setNoteOverrides((prev) => ({ ...prev, [id]: note }));
    void router?.invalidate().catch(() => {});
  };

  // The account scope as a row predicate: snapshot months filter
  // client-side; fetched months arrive pre-filtered and pass through
  // the same predicate, so one rule governs both sources.
  const scopedMonthTxns = useMemo(() => {
    const scoped = accountScope
      ? monthTxns.filter(
          (t) =>
            t.accountId === accountScope.account &&
            storePersonOf(t) === accountScope.person,
        )
      : monthTxns;
    if (Object.keys(noteOverrides).length === 0) return scoped;
    return scoped.map((t): Txn => {
      if (!(t.id in noteOverrides)) return t;
      const note = noteOverrides[t.id];
      const next: Txn = { ...t };
      if (note === null || note === undefined) delete next.userNote;
      else next.userNote = note;
      return next;
    });
  }, [monthTxns, accountScope, noteOverrides]);

  // The header total sums the WHOLE selected period — one month or
  // the full preset range — over the same scoped rows the list shows.
  const periodSpend = scopedMonthTxns
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
        // Search matches the merchant, the statement description and
        // the user's own note — the same fields /api/transactions'
        // q covers for fetched months.
        .filter((t) => {
          const needle = q.toLowerCase();
          return (
            t.merchant.toLowerCase().includes(needle) ||
            (t.note ?? "").toLowerCase().includes(needle) ||
            (t.userNote ?? "").toLowerCase().includes(needle)
          );
        })
        // Newest first by full date. The sort is stable, so rows within
        // a day keep their source order — and both month sources
        // (snapshot builder and /api/transactions) produce their rows
        // newest-first within the day, so the two agree.
        .sort((a, b) => b.date.localeCompare(a.date)),
    [person, q, whoActive, cat, scopedMonthTxns],
  );
  // Day groups, newest first (the list is already sorted). A single
  // month groups by day-of-month exactly as before; a range groups by
  // full date, since a day number alone repeats across months.
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: Txn[] }[] = [];
    const byKey = new Map<string, (typeof out)[number]>();
    for (const t of list) {
      const key = range ? t.date : `${t.monthKey}-${t.day}`;
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          label: range ? dateLabel(t.date) : dayLabel(t.day, false, t.monthKey),
          rows: [],
        };
        byKey.set(key, g);
        out.push(g);
      }
      g.rows.push(t);
    }
    return out;
  }, [list, range]);

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
      <PageTitle sub={`${gbp(periodSpend)} spent · transfers and savings not counted`}>Activity</PageTitle>
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
        <select className={sel} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
          <optgroup label="Ranges">
            {PERIOD_PRESETS.map((p) => (
              <option key={p.id} value={presetValue(p.id)}>{p.label}</option>
            ))}
          </optgroup>
          <optgroup label="Months">
            {monthOptions().map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </optgroup>
        </select>
      </div>

      {groups.length === 0 && <p className="py-12 text-center text-body text-muted-foreground">{monthLoaded ? "Nothing here." : "Loading…"}</p>}
      {groups.map((g) => (
        <div key={g.key} className="mb-5">
          <Label>{g.label}</Label>
          <div className="rounded-xl border bg-card px-4">
            {g.rows.map((t) => (
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
                  {t.userNote && <StickyNote aria-label="Has a note" className="h-3.5 w-3.5 text-muted-foreground" />}
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
                ["Who", personLabel(openTxn.owner)],
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
            <TransactionNote
              key={`note-${openTxn.id}`}
              transaction={openTxn}
              onSaved={(note) => applyNoteLocally(openTxn.id, note)}
            />
            <TransactionSubscription key={`sub-${openTxn.id}`} txn={openTxn} />
            <TransactionReceipt key={openTxn.id} transaction={openTxn} />
            <TransactionIdLine id={openTxn.id} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

/**
 * The user's own note on this transaction (POST /api/transactions/note,
 * stored in txn_notes by fingerprint). Plain and calm: a textarea and
 * one Save; an emptied note deletes itself on save. Distinct from the
 * statement description the sheet's "Note" row shows.
 */
function TransactionNote({
  transaction,
  onSaved,
}: {
  transaction: Txn;
  onSaved: (note: string | null) => void;
}) {
  const [draft, setDraft] = useState(transaction.userNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = draft.trim() !== (transaction.userNote ?? "");
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transactions/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: transaction.id, note: draft }),
      });
      if (!res.ok) throw new Error(`note request failed: ${res.status}`);
      const body = (await res.json()) as { note: string | null };
      onSaved(body.note);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Could not save that note — please try again.");
    }
    setBusy(false);
  };
  return (
    <section className="mt-5 border-t pt-4">
      <Label>Your note</Label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="Add a note to remember something about this payment…"
        aria-label="Your note"
        className="mt-2 w-full rounded-lg border bg-card px-3 py-2 text-body"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save note"}
        </Button>
        {saved && <span className="text-caption text-muted-foreground">Saved</span>}
      </div>
      {error && (
        <p className="mt-2 text-caption text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Subscription corrections for this transaction's merchant, written
 * through POST /api/subscriptions/override. Subscriptions are
 * merchant-level here, so every action states that it applies to all
 * of the merchant's payments. The current state comes from the
 * snapshot (detected sub + any override), with the just-saved mode
 * held locally so the block reflects a save immediately.
 */
function TransactionSubscription({ txn }: { txn: Txn }) {
  const router = useRouter();
  const key = canonicalMerchant(txn.merchant);
  const snapshotOverride = SUB_OVERRIDES.find((o) => o.merchant === key);
  const sub = SUBS.find((s) => canonicalMerchant(s.name) === key);
  const [local, setLocal] = useState<{ mode: SubscriptionOverrideMode | null } | null>(null);
  const mode = local ? local.mode : (snapshotOverride?.mode ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (next: SubscriptionOverrideMode | null) => {
    setBusy(true);
    setError(null);
    try {
      await postSubscriptionOverride(txn.merchant, next);
      setLocal({ mode: next });
      void router?.invalidate().catch(() => {});
    } catch {
      setError("That could not be saved — please try again.");
    }
    setBusy(false);
  };

  const stateLine =
    mode === "suppress"
      ? "Not a subscription — you removed it."
      : mode === "cancelled"
        ? "A subscription you marked cancelled."
        : mode === "force"
          ? "A subscription you added."
          : sub?.status === "Active"
            ? "This merchant is a subscription."
            : sub?.status === "Ended"
              ? "This merchant was a subscription (ended)."
              : sub?.status === "Cancelled"
                ? "A subscription marked cancelled."
                : null;

  return (
    <section className="mt-5 border-t pt-4">
      <Label>Subscription</Label>
      {stateLine && <p className="mt-1 text-body">{stateLine}</p>}
      <p className="mt-1 text-caption text-muted-foreground">
        Applies to all {txn.merchant} payments.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!sub && mode === null && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act("force")}>
            Mark as subscription
          </Button>
        )}
        {(sub?.status === "Active" || mode === "force") && mode !== "cancelled" && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act("cancelled")}>
            Mark cancelled
          </Button>
        )}
        {mode !== "suppress" && (sub || mode !== null) && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act("suppress")}>
            Not a subscription
          </Button>
        )}
        {mode !== null && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(null)}>
            Undo correction
          </Button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-caption text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The transaction's fingerprint, small and muted at the very bottom
 * of the sheet, with a copy button that confirms the copy briefly.
 */
function TransactionIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions, insecure context): the id
      // stays readable and selectable in the line itself.
    }
  };
  return (
    <div className="mt-5 border-t pt-3">
      <div className="text-caption text-muted-foreground">Transaction ID</div>
      <div className="mt-1 flex items-start justify-between gap-3">
        <span className="num min-w-0 break-all text-caption text-muted-foreground">{id}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy transaction ID"
          className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-caption text-muted-foreground transition hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
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
