import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { usePerson, Panel, Label, Sheet, Chip, meta } from "@/components/shell";
import { spendTotal, typicalTotal, biggestChanges, asideTotal, coachNote, currentMonthKey, currentMonthName, nextMonthName, gbp, TXNS, upcomingPanel, upcomingShare, upcomingDateLabel, incomeFor, incomeTotal, ownerName, personLabel, categoryColor, availableFor, formatMoney, dateLabel, monthlyHistoryFor, type IncomeEntry, type Person } from "@/lib/data";
import { smallSpendFact } from "@/lib/calculators";
import { AnimatedBar, CountUpMoney } from "@/components/motion";
import { AccountTile } from "@/components/tiles";
import { SpendTimelineSection } from "@/components/spend-chart";

export const Route = createFileRoute("/")({
  head: () => meta("This month", "This month at a glance for Zonito and Nikhila: spending, usual month, and a calm coach note."),
  component: Index,
});

/**
 * React key for a "Money in" row. Every income entry shares owner
 * values (all of Zonito's rows are "zonito"), so owner alone collides;
 * the entry's own label (salary or merchant) plus its date — with the
 * owner kept in — is unique per entry.
 */
export const incomeEntryKey = (entry: IncomeEntry): string =>
  `${entry.type}|${entry.day}|${entry.owner}`;

/**
 * Home "Available" card: the total balance across the current view's
 * accounts (household = everyone's, Joint included; a person's view =
 * their own accounts only), from the balances the latest real ingest
 * runs recorded. Tapping opens the per-account breakdown sheet, so a
 * big planned spend can be checked against what each account holds.
 * With no recorded balance at all the card says so honestly instead
 * of showing a fabricated £0.
 */
export function AvailableCard({ person, onOpen }: { person: Person; onOpen: () => void }) {
  const avail = availableFor(person);
  if (avail.gbpTotal === null) {
    return (
      <Panel>
        <Label>Available</Label>
        <p className="text-body leading-relaxed text-muted-foreground">
          No balances recorded yet — they appear here once a statement import records them.
        </p>
      </Panel>
    );
  }
  const known = avail.accounts.filter((a) => a.balanceMinor !== null).length;
  return (
    <Panel>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Available balance, show breakdown by account"
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <Label>Available</Label>
          <div className="num text-title font-semibold"><CountUpMoney value={avail.gbpTotal} pence /></div>
          {avail.foreign.length > 0 && (
            <p className="num mt-1 text-caption text-muted-foreground">
              plus {avail.foreign.map((f) => formatMoney(f.total, f.currency)).join(" · ")} in other currencies
            </p>
          )}
          <p className="mt-1 text-caption text-muted-foreground">
            Across {known} account{known === 1 ? "" : "s"} · as of {dateLabel(avail.asOf)}
          </p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </Panel>
  );
}

/** The breakdown sheet behind the Available card: every account in the
 *  view with its own balance (foreign money in its own currency, never
 *  converted), its owner and its last statement date. */
export function AvailableBreakdown({ person }: { person: Person }) {
  const avail = availableFor(person);
  return (
    <div>
      <div className="text-body text-muted-foreground">Available</div>
      <div className="num mb-1 text-title font-semibold">{avail.gbpTotal !== null ? gbp(avail.gbpTotal) : "—"}</div>
      <p className="mb-5 text-caption text-muted-foreground">
        {person === "household"
          ? "Every account — yours, Nikhila's and Joint"
          : `${ownerName(person as "zonito" | "nikhila")}'s own accounts`}
        {avail.asOf ? ` · as of ${dateLabel(avail.asOf)}` : ""}
      </p>
      {avail.accounts.map((a) => (
        <div key={`${a.owner}:${a.name}`} className="ledger-row flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <AccountTile account={a.name} />
            <div className="min-w-0">
              <div className="truncate text-body">{a.name}</div>
              <div className="text-caption text-muted-foreground">
                {personLabel(a.owner)} · last upload {dateLabel(a.lastDate)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {a.stale && <Chip tone="warn">Stale</Chip>}
            <span className="num text-body">
              {a.balanceMinor !== null ? formatMoney(a.balanceMinor / 100, a.currency) : "Not recorded"}
            </span>
          </div>
        </div>
      ))}
      <div className="mt-4 border-t pt-4">
        <div className="flex items-center justify-between">
          <span className="text-body font-medium">Total available</span>
          <span className="num text-body font-semibold">{avail.gbpTotal !== null ? gbp(avail.gbpTotal) : "—"}</span>
        </div>
        {avail.foreign.map((f) => (
          <div key={f.currency} className="num mt-1.5 flex items-center justify-between text-caption text-muted-foreground">
            <span>held in {f.currency}</span>
            <span>{formatMoney(f.total, f.currency)}</span>
          </div>
        ))}
        {avail.asOf && (
          <p className="mt-3 text-caption text-muted-foreground">
            As of {dateLabel(avail.asOf)} — the latest statement across these accounts.
          </p>
        )}
      </div>
    </div>
  );
}

export function Index() {
  const { person } = usePerson();
  const [availableOpen, setAvailableOpen] = useState(false);
  // The spend trend under the summary: the shared timeline section in
  // its compact form, over the same snapshot monthly history the
  // Categories chart reads (person-view aware, no fetch but Daily).
  const monthly = useMemo(() => monthlyHistoryFor(person), [person]);
  // No data at all: one honest empty state instead of five £0 panels
  // and captions with a dangling month ("Spent in ", "Coming up · ").
  // The month-interpolating captions below only render past this guard.
  if (!currentMonthKey() || TXNS.length === 0) {
    return (
      <Panel>
        <Label>Home</Label>
        <p className="text-heading font-semibold">No statements imported yet</p>
        <p className="mt-2 text-body leading-relaxed text-muted-foreground">
          Once statements are imported, this screen shows the month at a glance. Head to{" "}
          <Link to="/import" className="font-medium text-primary underline underline-offset-4">Import</Link>{" "}
          to add the first ones.
        </p>
      </Panel>
    );
  }
  const coming = upcomingPanel(person);
  const total = spendTotal(person);
  const usual = typicalTotal(person);
  const diff = total - usual;
  const small = smallSpendFact(TXNS, person);
  return (
    <>
    <div className="space-y-5 lg:grid lg:grid-cols-2 lg:grid-rows-[auto_auto_1fr] lg:items-start lg:gap-6 lg:space-y-0">
      <div className="space-y-5 lg:space-y-6">
      <div className="hero-panel rounded-xl p-5">
        <div className="hero-label mb-2 text-micro font-medium uppercase tracking-[0.08em]">Spent in {currentMonthName()}</div>
        <div className="hero-number font-display num text-hero"><CountUpMoney value={total} /></div>
        <p className="hero-comparison num mt-2 text-caption">
          {gbp(Math.abs(diff), false)} {diff >= 0 ? "more" : "less"} than a typical month ({gbp(usual, false)})
        </p>
        <div className="mt-3 space-y-1.5" role="img" aria-label={`${currentMonthName()} ${gbp(total, false)}; typical month ${gbp(usual, false)}`}>
          {[{ name: currentMonthName(), value: total, colour: "bg-accent" }, { name: "Typical", value: usual, colour: "bg-hero-foreground/35" }].map((bar) => (
            <div key={bar.name} className="flex items-center gap-2" aria-hidden="true">
              <span className="w-10 shrink-0 text-micro text-hero-foreground">{bar.name}</span>
              <div className="hero-track h-1.5 flex-1 rounded-lg"><AnimatedBar percent={bar.value / Math.max(total, usual, 1) * 100} className={bar.colour} /></div>
            </div>
          ))}
        </div>
      </div>

      <AvailableCard person={person} onOpen={() => setAvailableOpen(true)} />

      <Link to="/coach" className="block">
        <Panel className="bg-accent/8!">
          <Label>Coach</Label>
          <p className="num text-body leading-relaxed">{coachNote(person)}</p>
        </Panel>
      </Link>

      </div>

      <div className="space-y-5 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:space-y-6">
      <Panel>
        <Label>Biggest changes</Label>
        {biggestChanges(person).map((c) => (
          <div key={c.category} className="ledger-row flex items-center justify-between py-3">
            <span className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(c.category) }} />{c.category}</span>
            <span className="num text-body text-foreground">
              {c.diff > 0 ? "+" : "−"}{gbp(Math.abs(c.diff), false)}
            </span>
          </div>
        ))}
      </Panel>

      <Panel>
        <Label>Money in · {currentMonthName()}</Label>
        <div className="num text-title font-semibold text-good"><CountUpMoney value={incomeTotal(person)} /></div>
        <div className="mt-3">
          {incomeFor(person).map((entry) => (
            <div key={incomeEntryKey(entry)} className="ledger-row flex items-center justify-between gap-3 py-2 text-body">
              <span>{entry.type} · {personLabel(entry.owner)}</span>
              <span className="num shrink-0">{gbp(entry.amount, false)}</span>
            </div>
          ))}
        </div>
        {asideTotal(person) > 0 && <p className="num mt-3 text-caption text-muted-foreground">Of this, {gbp(asideTotal(person), false)} was moved aside.</p>}
      </Panel>

      <Panel className="flex items-center justify-between">
        <div>
          <Label>Moved aside</Label>
          <p className="text-caption text-muted-foreground">Savings & investments, not spending</p>
        </div>
        <span className="num text-heading font-semibold text-aside">{gbp(asideTotal(person), false)}</span>
      </Panel>
      </div>

      <Panel className="lg:col-start-1 lg:row-start-3">
        <Label>Coming up · {nextMonthName()}</Label>
        <p className="text-heading font-semibold leading-relaxed"><span className="num">{gbp(coming.total, false)}</span> of regulars already known</p>
        <div className="mt-3">
          {coming.visible.map((payment) => (
            <div key={payment.name} className="ledger-row flex items-center justify-between gap-3 py-2.5 text-body">
              <div className="min-w-0">
                <div>{payment.name}</div>
                <div className="mt-0.5 text-caption text-muted-foreground">{upcomingDateLabel(payment.date)}</div>
              </div>
              <span className="num shrink-0">{gbp(upcomingShare(payment, person))}</span>
            </div>
          ))}
          {coming.restCount > 0 && (
            <div className="ledger-row py-2.5 text-body text-muted-foreground">
              and {coming.restCount} more · <span className="num">{gbp(coming.restTotal)}</span>
            </div>
          )}
        </div>
        <p className="mt-3 text-caption leading-relaxed text-muted-foreground">The regulars we already know about. One-offs and day-to-day spending are on top.</p>
      </Panel>
      <Panel className="lg:col-start-1 lg:row-start-2">
        <Label>Small spends</Label>
        <p className="num text-body leading-relaxed">
          Spends under £10 added up to {gbp(small.total)} this month across {small.count} spends.{small.total >= 40 && " That is roughly a family day out."}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden="true">
          {Array.from({ length: small.count }, (_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-primary/60" />)}
        </div>
        <div className="mt-2 h-1 rounded-lg bg-muted" role="img" aria-label={`${gbp(small.total)} in small spends out of ${gbp(total)} spent in ${currentMonthName()}`}>
          <AnimatedBar percent={total > 0 ? small.total / total * 100 : 0} className="bg-primary/60" />
        </div>
      </Panel>
    </div>
    <div className="mt-5 lg:mt-6">
      <SpendTimelineSection
        title="Spending trend"
        monthly={monthly}
        dailyPerson={person}
        compact
      />
    </div>
    <Sheet open={availableOpen} onClose={() => setAvailableOpen(false)}>
      <AvailableBreakdown person={person} />
    </Sheet>
    </>
  );
}
