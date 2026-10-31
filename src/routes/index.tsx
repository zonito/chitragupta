import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { usePerson, Panel, Label, Sheet, Chip, meta } from "@/components/shell";
import { spendTotal, typicalTotal, biggestChanges, asideTotal, coachNote, currentMonthKey, currentMonthName, nextMonthName, gbp, TXNS, upcomingPanel, upcomingShare, upcomingDateLabel, incomeFor, incomeTotal, ownerName, personLabel, categoryColor, availableFor, appSettings, formatMoney, dateLabel, monthlyHistoryFor, type IncomeEntry, type Person } from "@/lib/data";
import { smallSpendFact } from "@/lib/calculators";
import { AnimatedBar, CountUpMoney } from "@/components/motion";
import { AccountTile } from "@/components/tiles";
import { SpendTimelineSection } from "@/components/spend-chart";
import { fetchJevCoachOpinion, type JevOpinion } from "@/lib/jev-client";

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
/** A threshold figure with pence only when it has them (£11,000 /
 * £10,306.75): a floor the user typed is quoted back exactly. */
const gbpTrim = (n: number) => gbp(n, n % 1 !== 0);

/** The Available floor state for one view: the configured floor (in
 * pounds) and whether the view's GBP headline sits below it. Null
 * floor = no signal anywhere. The comparison uses the very number the
 * card displays, so what you see is what is judged. */
export function floorState(person: Person): { floor: number; below: boolean } | null {
  const { availableFloorMinor } = appSettings();
  if (availableFloorMinor === null) return null;
  const total = availableFor(person).gbpTotal;
  if (total === null) return null;
  const floor = availableFloorMinor / 100;
  return { floor, below: total < floor };
}

export function AvailableCard({ person, onOpen, className }: { person: Person; onOpen: () => void; className?: string }) {
  const avail = availableFor(person);
  if (avail.gbpTotal === null) {
    return (
      <Panel {...(className ? { className } : {})}>
        <Label>Available</Label>
        <p className="text-body leading-relaxed text-muted-foreground">
          No balances recorded yet — they appear here once a statement import records them.
        </p>
      </Panel>
    );
  }
  const known = avail.accounts.filter((a) => a.balanceMinor !== null).length;
  const floor = floorState(person);
  return (
    <Panel {...(className ? { className } : {})}>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Available balance, show breakdown by account"
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <Label>Available</Label>
          <div className={`num text-title font-semibold${floor?.below ? " text-destructive" : ""}`}><CountUpMoney value={avail.gbpTotal} pence /></div>
          {avail.foreign.length > 0 && (
            <p className="num mt-1 text-caption text-muted-foreground">
              plus {avail.foreign.map((f) => formatMoney(f.total, f.currency)).join(" · ")} in other currencies
            </p>
          )}
          {floor !== null &&
            (floor.below ? (
              <p className="num mt-1 text-caption font-medium text-destructive">
                Below your {gbpTrim(floor.floor)} floor
              </p>
            ) : (
              <p className="num mt-1 text-caption text-muted-foreground">
                Floor {gbpTrim(floor.floor)}
              </p>
            ))}
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
  const floor = floorState(person);
  return (
    <div>
      <div className="text-body text-muted-foreground">Available</div>
      <div className={`num mb-1 text-title font-semibold${floor?.below ? " text-destructive" : ""}`}>{avail.gbpTotal !== null ? gbp(avail.gbpTotal) : "—"}</div>
      {floor !== null &&
        (floor.below ? (
          <p className="num mb-1 text-caption font-medium text-destructive">
            Below your {gbpTrim(floor.floor)} floor
          </p>
        ) : (
          <p className="num mb-1 text-caption text-muted-foreground">
            Floor {gbpTrim(floor.floor)}
          </p>
        ))}
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

/**
 * Jev's second opinion on the Coach card: a separated, labelled block
 * under the deterministic Coach note, showing the two choices Jev
 * picked — verbatim, with no figures of its own. Fetched after render
 * (the server caches per view per day and fails open), so the card
 * never waits on Jev; when Jev is off, down, or has never answered,
 * this renders nothing and the card is exactly the pre-Jev card.
 */
export function JevCoachOpinion({ person }: { person: Person }) {
  const enabled = appSettings().jevEnabled;
  const [opinion, setOpinion] = useState<JevOpinion | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const next = await fetchJevCoachOpinion(person);
      if (!cancelled) setOpinion(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [person, enabled]);

  if (!enabled || !opinion) return null;
  const posture = opinion.answers["posture"];
  const lever = opinion.answers["lever"];
  if (!posture && !lever) return null;
  return (
    <div className="mt-3 border-t border-foreground/10 pt-3">
      <div className="text-caption font-semibold tracking-wide text-muted-foreground uppercase">
        Jev&rsquo;s second opinion
      </div>
      {posture && (
        <p className="mt-1 text-body leading-relaxed">
          Posture: <span className="font-medium">{posture}</span>
        </p>
      )}
      {lever && (
        <p className="text-body leading-relaxed">
          Lever: <span className="font-medium">{lever}</span>
        </p>
      )}
      <p className="num mt-1 text-caption text-muted-foreground">
        {dateLabel(opinion.at.slice(0, 10))}
      </p>
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
  // Overall monthly budget (Settings): a slim progress line under the
  // hero's own bars. Null = no budget, and the hero is exactly as it
  // was. Judged on this view's current-month spend total.
  const { overallMonthlyBudgetMinor } = appSettings();
  const overallBudget =
    overallMonthlyBudgetMinor !== null ? overallMonthlyBudgetMinor / 100 : null;
  const overBudget = overallBudget !== null && total > overallBudget;
  return (
    <>
    {/* Home is a defined grid ordered by value, highest first (source
        order = the mobile single-column order):
        row 1 hero + Available, row 2 the trend chart full width,
        row 3 Coming up + Biggest changes with Coach in that column,
        row 4 Money in + Small spends, row 5 Moved aside as a slim
        strip. Paired cells share their row's height; nothing is left
        as an orphan column with vertical voids. */}
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:gap-6">
      <div className="hero-panel rounded-xl p-5 lg:col-start-1 lg:row-start-1">
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
        {overallBudget !== null && (
          <div className="mt-3">
            <div
              className="hero-track h-1.5 rounded-lg"
              role="img"
              aria-label={`${gbp(total, false)} of ${gbp(overallBudget, false)} monthly budget${overBudget ? `; ${gbp(total - overallBudget, false)} over budget` : ""}`}
            >
              <AnimatedBar
                percent={overallBudget > 0 ? (total / overallBudget) * 100 : total > 0 ? 100 : 0}
                className={overBudget ? "" : "bg-accent"}
                {...(overBudget ? { colour: "var(--danger-on-hero)" } : {})}
              />
            </div>
            <p className="hero-comparison num mt-2 text-caption">
              {gbp(total, false)} of {gbp(overallBudget, false)} budget
              {overBudget && (
                <>
                  {" · "}
                  <span className="hero-danger font-medium">
                    {gbp(total - overallBudget, false)} over budget
                  </span>
                </>
              )}
            </p>
          </div>
        )}
      </div>

      <AvailableCard person={person} onOpen={() => setAvailableOpen(true)} className="lg:col-start-2 lg:row-start-1" />

      <SpendTimelineSection
        title="Spending trend"
        surface="home"
        monthly={monthly}
        dailyPerson={person}
        compact
        className="lg:col-span-2 lg:row-start-2"
      />

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

      <div className="space-y-5 lg:col-start-2 lg:row-start-3 lg:space-y-6">
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

        <Link to="/coach" className="block">
          <Panel className="bg-accent/8!">
            <Label>Coach</Label>
            <p className="num text-body leading-relaxed">{coachNote(person)}</p>
            <JevCoachOpinion person={person} />
          </Panel>
        </Link>
      </div>

      <Panel className="lg:col-start-1 lg:row-start-4">
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

      <Panel className="lg:col-start-2 lg:row-start-4">
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

      {/* Moved aside is context, not a headline: a slim one-line strip
          (label, amount, what it is), not a full card. The label is a
          span here, not <Label>: the strip is a single flex line and
          Label's block margin would misalign it. */}
      <Panel className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3! lg:col-span-2 lg:row-start-5">
        <span className="text-micro font-medium uppercase tracking-[0.08em] text-muted-foreground">Moved aside</span>
        <span className="num text-heading font-semibold text-aside">{gbp(asideTotal(person), false)}</span>
        <span className="text-caption text-muted-foreground">Savings & investments, not spending</span>
      </Panel>
    </div>
    <Sheet open={availableOpen} onClose={() => setAvailableOpen(false)}>
      <AvailableBreakdown person={person} />
    </Sheet>
    </>
  );
}
