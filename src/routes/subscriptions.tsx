import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Chip, Label, Sheet, meta } from "@/components/shell";
import { SUBS, monthlyOf, yearlyOf, gbp, ownerName, dateLabel, latestDataDate, type Sub, type Txn } from "@/lib/data";
import { fetchApiTransactions } from "@/lib/txn-map";
import { subscriptionMonthlyRows } from "@/lib/timeline";
import { SpendTimelineSection } from "@/components/spend-chart";
import { MerchantTile } from "@/components/tiles";

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
  const ended = list.filter((s) => s.status === "Ended");
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

      {ended.length > 0 && (
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
            <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              {ended.map((s) => <SubCard key={s.name} sub={s} person={person} onOpen={() => setSelected(s)} />)}
            </div>
          )}
        </section>
      )}

      {list.length === 0 && (
        <Panel className="p-4 text-body text-muted-foreground">
          No recurring charges detected yet. A subscription appears here once the same amount has been charged on a regular cycle.
        </Panel>
      )}

      <Sheet open={!!selected} onClose={() => setSelected(null)}>
        {selected && <SubDetail key={selected.name} sub={selected} />}
      </Sheet>
    </div>
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
          {person === "household" && <> · {ownerName(s.owner)}</>}
          {s.note && <div className="mt-0.5 text-body">{s.note}</div>}
        </div>
      </button>
    </Panel>
  );
}

function SubDetail({ sub }: { sub: Sub }) {
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
    </div>
  );
}
