import { createFileRoute } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Label, Chip, meta } from "@/components/shell";
import { MerchantTile } from "@/components/tiles";
import { biggestChanges, biggestOneOff, newMerchants, weeklySpend, gbp, dateLabel, MONTHS6, sparkFor, weekdayLunchFact, SUBS, CATEGORY_COLOR, type Category } from "@/lib/data";

export const Route = createFileRoute("/coach")({
  head: () => meta("Coach", "A weekly digest and a few plain-words insights about your household spending."),
  component: Coach,
});

function Coach() {
  const { person } = usePerson();
  // Every insight below is derived from the loaded month's real data —
  // biggest category change, subscription price rises, new merchants, the
  // biggest one-off. Nothing is written from memory of sample data.
  const [top] = biggestChanges(person);
  const chartCategory: Category | null = top && top.usual > 0 && Math.abs(top.diff) >= 25 ? top.category : null;
  const series = chartCategory ? sparkFor(chartCategory, person) : [];
  const max = Math.max(...series, 1);

  const insights: { t: string; b: string; chart?: boolean; newMerchant?: { name: string; category: Category } }[] = [];
  if (top && chartCategory) {
    const pct = Math.round((top.diff / top.usual) * 100);
    insights.push({
      t: `${top.category} ${top.diff > 0 ? "up" : "down"} ${Math.abs(pct)}% vs usual`,
      b: `${gbp(top.now, false)} this month against a usual ${gbp(top.usual, false)}.`,
      chart: true,
    });
  }
  const risen = SUBS.find((s) => s.note?.includes("→"));
  if (risen) {
    const prev = risen.note ? Number(risen.note.replace(/,/g, "").match(/£([\d.]+)/)?.[1]) : NaN;
    insights.push({
      t: "A subscription price went up",
      b: Number.isFinite(prev)
        ? `${risen.name} is now ${gbp(risen.amount)}, up from ${gbp(prev)}. That's ${gbp((risen.amount - prev) * 12, false)} more a year.`
        : `${risen.name} is now ${gbp(risen.amount)}${risen.note ? ` (${risen.note})` : ""}.`,
    });
  }
  const [newMerchant] = newMerchants();
  if (newMerchant) {
    insights.push({
      t: "New merchant",
      b: `${newMerchant.merchant}, ${gbp(newMerchant.amount)} on ${dateLabel(newMerchant.date)}. First time we've seen it.`,
      newMerchant: { name: newMerchant.merchant, category: newMerchant.category },
    });
  }
  const oneOff = biggestOneOff(person);
  if (oneOff && oneOff.amount >= 250) {
    insights.push({
      t: "One big one-off this month",
      b: `${oneOff.merchant}, ${gbp(oneOff.amount, false)}. Tagged one-off, so it won't skew your usual month.`,
    });
  }
  const week = weeklySpend(person);
  const lunch = weekdayLunchFact(person);
  if (lunch.count > 0) insights.push({
    t: "Weekday lunches, added up",
    b: `${gbp(lunch.each)} Pret lunches ${lunch.count} times this month is ${gbp(lunch.total)}; at that pace, about ${gbp(lunch.year, false)} a year.`,
  });

  return (
    <div>
      <PageTitle sub="Plain words, one idea at a time">Coach</PageTitle>

      <Panel className="mb-6 bg-accent/8! text-foreground">
        <div className="mb-2 text-micro font-medium uppercase tracking-[0.08em] text-accent-ink">Sunday digest · preview</div>
        <p className="num text-body leading-relaxed">
          This week you spent {gbp(week.thisWeek)}. {week.thisWeek < week.lastWeek ? "Quieter" : week.thisWeek > week.lastWeek ? "Busier" : "The same as"} {week.thisWeek === week.lastWeek ? "last week" : "than last week"} ({gbp(week.lastWeek)}).
        </p>
        <p className="mt-3 text-caption text-muted-foreground">Arrives Sunday evening.</p>
      </Panel>

      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        {insights.length === 0 && (
          <Panel>
            <h3 className="text-heading font-semibold">Nothing stands out</h3>
            <p className="num mt-1.5 text-body leading-relaxed text-muted-foreground">No category is far from its usual month, and no new merchants or price rises yet.</p>
          </Panel>
        )}
        {insights.map((i, index) => (
          <Panel key={index}>
            <div className="flex items-center gap-2">
              {i.newMerchant && <MerchantTile merchant={i.newMerchant.name} category={i.newMerchant.category} />}
              {i.newMerchant && <Chip>New</Chip>}
              <h3 className="text-heading font-semibold">{i.t}</h3>
            </div>
            <p className="num mt-1.5 text-body leading-relaxed text-muted-foreground">{i.b}</p>
            {i.chart && chartCategory && (
              <div className="mt-5">
                <div className="flex h-20 items-end gap-2">
                  {series.map((v, k) => (
                    <div key={k} className="flex flex-1 flex-col items-center gap-1">
                      <div className={`chart-grow w-full rounded-t ${k === series.length - 1 ? "" : "opacity-40"}`} style={{ height: `${(v / max) * 64}px`, backgroundColor: CATEGORY_COLOR[chartCategory], animationDelay: `${k * 35}ms` }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex gap-2">
                  {MONTHS6.map((m, k) => <span key={`${m}-${k}`} className="flex-1 text-center text-micro text-muted-foreground">{m}</span>)}
                </div>
              </div>
            )}
          </Panel>
        ))}
      </div>
      <div className="mt-6"><Label>That's all for now</Label></div>
    </div>
  );
}
