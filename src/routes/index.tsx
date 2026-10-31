import { createFileRoute, Link } from "@tanstack/react-router";
import { usePerson, Panel, Label, meta } from "@/components/shell";
import { spendTotal, typicalTotal, biggestChanges, asideTotal, coachNote, currentMonthName, nextMonthName, gbp, TXNS, upcomingPanel, upcomingShare, upcomingDateLabel, incomeFor, incomeTotal, ownerName, CATEGORY_COLOR } from "@/lib/data";
import { smallSpendFact } from "@/lib/calculators";
import { AnimatedBar, CountUpMoney } from "@/components/motion";

export const Route = createFileRoute("/")({
  head: () => meta("This month", "This month at a glance for Zonito and Nikhila: spending, usual month, and a calm coach note."),
  component: Index,
});

function Index() {
  const { person } = usePerson();
  const coming = upcomingPanel(person);
  const total = spendTotal(person);
  const usual = typicalTotal(person);
  const diff = total - usual;
  const small = smallSpendFact(TXNS, person);
  return (
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
            <span className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORY_COLOR[c.category] }} />{c.category}</span>
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
            <div key={entry.owner} className="ledger-row flex items-center justify-between gap-3 py-2 text-body">
              <span>{entry.type} · {ownerName(entry.owner)}</span>
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
  );
}
