import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Chip, Label, Sheet, meta } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { SUBS, SUB_OVERRIDES, monthlyOf, yearlyOf, gbp, personLabel, dateLabel, latestDataDate, type Sub, type Txn } from "@/lib/data";
import { fetchApiTransactions } from "@/lib/txn-map";
import { subscriptionMonthlyRows } from "@/lib/timeline";
import { SpendTimelineSection } from "@/components/spend-chart";
import { MerchantTile } from "@/components/tiles";
import { canonicalMerchant } from "@/lib/subscriptions";
import { postSubscriptionOverride, type SubscriptionOverrideMode } from "@/lib/subscription-overrides";

export const Route = createFileRoute("/subscriptions")({
  head: () => meta("Subscriptions", "Recurring charges, yearly cost, and which card each one sits on."),
  component: Subs,
});

/**
 * How a subscription's next charge reads. The detector's status stays
 * exactly as computed — an Active sub whose expected date has already
 * passed relative to the latest data is not relabelled, it just must
 * not claim that past date is still "next".
 */
export function nextExpectedLabel(s: Sub): string | null {
  if (s.status !== "Active" || !s.nextExpected) return null;
  const latest = latestDataDate();
  return latest && s.nextExpected < latest
    ? `next was due ${dateLabel(s.nextExpected)}`
    : `next ${dateLabel(s.nextExpected)}`;
}

const PAGE_SIZE = 10;
const SECTION_ORDER: Sub["freq"][] = ["Monthly", "Yearly", "Quarterly", "Weekly"];

export function Subs() {
  const { person } = usePerson();
  const [selected, setSelected] = useState<Sub | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const list = SUBS.filter((s) => person === "household" || s.owner === person);
  const active = list.filter((s) => s.status === "Active");
  // The Ended area also holds user-cancelled subs (their chip says
  // Cancelled, distinct from the detector's Ended).
  const ended = list.filter((s) => s.status !== "Active");
  // Merchants the user suppressed outright: not subscriptions at all,
  // listed in the Ended area with a Restore for each.
  const removed = SUB_OVERRIDES.filter((o) => o.mode === "suppress");
  // The detail sheet renders the freshest copy of the selected sub,
  // so a correction saved from inside it shows in place.
  const selectedSub = selected
    ? (SUBS.find((s) => s.name === selected.name) ?? selected)
    : null;
  const m = active.reduce((a, s) => a + monthlyOf(s), 0);
  const yearly = active.reduce((a, s) => a + yearlyOf(s), 0);
  const largest = [...active].sort((a, b) => yearlyOf(b) - yearlyOf(a))[0];
  // The recurring-cost trend: the shared timeline section over the
  // detector's own charge history (active subs in this view, summed
  // per month), so a creeping subscription bill is visible at a glance.
  const subsMonthly = useMemo(() => subscriptionMonthlyRows(person), [person]);
  return (
    <div>
      <PageTitle>Subscriptions</PageTitle>
      <Panel className="mb-6 grid grid-cols-2">
        <div><Label>Per month</Label><div className="num text-title font-semibold">{gbp(m)}</div></div>
        <div><Label>Per year</Label><div className="num text-title font-semibold">{gbp(m * 12)}</div></div>
        <div className="col-span-2 mt-4">
          <div className="flex h-2 overflow-hidden rounded-lg bg-muted" role="img" aria-label={active.map(s => `${s.name}: ${gbp(yearlyOf(s))} a year`).join("; ")}>
            {active.map((s, i) => <span key={s.name} className="h-full bg-primary" style={{ width: `${yearly > 0 ? yearlyOf(s) / yearly * 100 : 0}%`, opacity: 0.3 + (i % 5) * 0.14 }} />)}
          </div>
          {largest && <p className="num mt-2 text-caption text-muted-foreground">{largest.name} · {gbp(yearlyOf(largest))}/year</p>}
        </div>
      </Panel>

      {list.length > 0 && (
        <SpendTimelineSection
          title="Recurring cost over time"
          surface="subscriptions"
          monthly={subsMonthly}
          seriesName="Subscriptions"
          className="mb-6"
          caption="Active subscriptions only — the charges the detector found, summed per month."
        />
      )}

      {SECTION_ORDER.map((freq) => {
        const section = active.filter((s) => s.freq === freq);
        if (section.length === 0) return null;
        return (
          <section key={freq} className="mb-8">
            <h2 className="mb-3 text-heading font-semibold">{freq}</h2>
            <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              {section.map((s) => <SubCard key={s.name} sub={s} person={person} onOpen={() => setSelected(s)} />)}
            </div>
          </section>
        );
      })}

      {(ended.length > 0 || removed.length > 0) && (
        <section className="mb-8">
          <h2 className="mb-3 text-heading font-semibold">
            <button
              type="button"
              aria-expanded={endedOpen}
              onClick={() => setEndedOpen((open) => !open)}
              className="flex items-center gap-2"
            >
              Ended
              <span className="num text-caption font-normal text-muted-foreground">
                {ended.length} subscription{ended.length === 1 ? "" : "s"}
              </span>
              <span aria-hidden="true" className="text-caption text-muted-foreground">
                {endedOpen ? "▾" : "▸"}
              </span>
            </button>
          </h2>
          {endedOpen && (
            <>
              {ended.length > 0 && (
                <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
                  {ended.map((s) => <SubCard key={s.name} sub={s} person={person} onOpen={() => setSelected(s)} />)}
                </div>
              )}
              {removed.length > 0 && (
                <div className="mt-5">
                  <Label>Removed by you</Label>
                  <div className="mt-2 space-y-2">
                    {removed.map((o) => (
                      <div
                        key={o.merchant}
                        className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
                      >
                        <span className="text-body">{o.label}</span>
                        <RestoreButton label={o.label} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {list.length === 0 && removed.length === 0 && (
        <Panel className="p-4 text-body text-muted-foreground">
          No recurring charges detected yet. A subscription appears here once the same amount has been charged on a regular cycle.
        </Panel>
      )}

      <Sheet open={!!selectedSub} onClose={() => setSelected(null)}>
        {selectedSub && (
          <SubDetail
            key={selectedSub.name}
            sub={selectedSub}
            onClose={() => setSelected(null)}
          />
        )}
      </Sheet>
    </div>
  );
}

/** Restore a suppressed merchant: clearing its override lets the
 * detector's own verdict return on the next snapshot. */
function RestoreButton({ label }: { label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      await postSubscriptionOverride(label, null);
      await router?.invalidate().catch(() => {});
    } catch {
      // The row stays; the user can retry.
    }
    setBusy(false);
  };
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore()}>
      Restore
    </Button>
  );
}

function SubCard({ sub: s, person, onOpen }: { sub: Sub; person: string; onOpen: () => void }) {
  return (
    <Panel className="p-4">
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`${s.name} transactions`}>
        <div className="flex items-start justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <MerchantTile merchant={s.name} category="Subscriptions" />
            <div className="min-w-0">
              <div className="text-body font-medium">{s.name}</div>
              <div className="num text-caption text-muted-foreground">{s.freq} · {gbp(yearlyOf(s))} a year</div>
            </div>
          </div>
          <div className="num amount shrink-0 text-right">{gbp(s.amount)}</div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip tone={s.status === "Active" ? "good" : "neutral"}>{s.status}</Chip>
          {s.note?.includes("→") && <Chip tone="warn">Price increased</Chip>}
        </div>
        <div className="mt-3 text-caption text-muted-foreground">
          {s.card} · last charged {s.last}
          {nextExpectedLabel(s) && <> · {nextExpectedLabel(s)}</>}
          {person === "household" && <> · {personLabel(s.owner)}</>}
          {s.note && <div className="mt-0.5 text-body">{s.note}</div>}
        </div>
      </button>
    </Panel>
  );
}

function SubDetail({ sub, onClose }: { sub: Sub; onClose: () => void }) {
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Exactly this subscription's own cluster charges, by fingerprint:
        // the count always matches the card, and unrelated purchases from
        // the same merchant (Supercharging, app purchases) never appear.
        const rows = await fetchApiTransactions({
          ids: sub.chargeIds.join(","),
          limit: "1000",
        });
        if (cancelled) return;
        const sorted = [...rows].sort(
          (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
        );
        setTxns(sorted);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [sub]);

  const pages = txns ? Math.max(1, Math.ceil(txns.length / PAGE_SIZE)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = txns ? txns.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : [];

  return (
    <div>
      <div className="text-body text-muted-foreground">{sub.name}</div>
      <div className="num mb-1 text-title font-semibold">{gbp(sub.amount)}</div>
      <p className="mb-5 text-caption text-muted-foreground">
        {sub.freq} · {sub.charges} recurring charge{sub.charges === 1 ? "" : "s"} · last charged {sub.last}
        {nextExpectedLabel(sub) ? ` · ${nextExpectedLabel(sub)}` : ` · ${sub.status}`}
      </p>

      {txns === null && !failed && <p className="text-body text-muted-foreground">Loading transactions…</p>}
      {failed && <p className="text-body text-muted-foreground">Transactions could not be loaded just now.</p>}
      {txns !== null && txns.length === 0 && (
        <p className="text-body text-muted-foreground">No transactions found for this subscription.</p>
      )}

      {visible.length > 0 && (
        <div>
          {visible.map((t) => (
            <div key={t.id} className="ledger-row flex items-center justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-body">{t.note ?? t.merchant}</div>
                <div className="num text-caption text-muted-foreground">{dateLabel(t.date)} · {t.merchant}</div>
              </div>
              <span className="num shrink-0 text-body font-medium">{gbp(t.amount)}</span>
            </div>
          ))}
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              className="text-body font-medium disabled:opacity-40"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <span className="num text-caption text-muted-foreground">Page {current + 1} of {pages}</span>
            <button
              type="button"
              className="text-body font-medium disabled:opacity-40"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      <SubOverrideActions sub={sub} onClose={onClose} />
    </div>
  );
}

/**
 * The user's corrections for this subscription, written through
 * POST /api/subscriptions/override (merchant-wide). Cancelling keeps
 * the sub visible as Cancelled in the Ended area; "Not a
 * subscription" removes it outright (it lands in Removed by you,
 * restorable). Undo returns the detector's own verdict exactly.
 */
function SubOverrideActions({ sub, onClose }: { sub: Sub; onClose: () => void }) {
  const router = useRouter();
  const override = SUB_OVERRIDES.find(
    (o) => o.merchant === canonicalMerchant(sub.name),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const act = async (mode: SubscriptionOverrideMode | null, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await postSubscriptionOverride(sub.name, mode);
      await router?.invalidate().catch(() => {});
      if (close) {
        onClose();
        return;
      }
      setDone(
        mode === null
          ? "Correction undone — the detector's own result is back."
          : mode === "cancelled"
            ? "Marked cancelled."
            : "Removed from subscriptions.",
      );
    } catch {
      setError("That could not be saved — please try again.");
    }
    setBusy(false);
  };

  return (
    <section className="mt-5 border-t pt-4">
      <Label>Your correction</Label>
      {override?.mode === "force" && (
        <p className="mt-1 text-caption text-muted-foreground">You added this subscription.</p>
      )}
      {override?.mode === "cancelled" && (
        <p className="mt-1 text-caption text-muted-foreground">
          You marked this subscription cancelled.
        </p>
      )}
      <p className="mt-1 text-caption text-muted-foreground">
        Applies to all {sub.name} payments.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {sub.status === "Active" && override?.mode !== "cancelled" && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act("cancelled")}>
            Mark cancelled
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void act("suppress", true)}
        >
          Not a subscription
        </Button>
        {override && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void act(null, override.mode === "force")}
          >
            Undo correction
          </Button>
        )}
      </div>
      {done && <p className="mt-2 text-caption text-muted-foreground">{done}</p>}
      {error && (
        <p className="mt-2 text-caption text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
