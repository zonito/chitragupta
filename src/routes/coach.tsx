import { createFileRoute } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Label, Chip, meta } from "@/components/shell";
import { MerchantTile } from "@/components/tiles";
import { byCategory, typicalFor, weeklySpend, gbp, MONTHS6, sparkFor, weekdayLunchFact, CATEGORY_COLOR } from "@/lib/data";

export const Route = createFileRoute("/coach")({
  head: () => meta("Coach", "A weekly digest and a few plain-words insights about your household spending."),
  component: Coach,
});

function Coach() {
  const { person } = usePerson();
  const eat = byCategory(person).find((c) => c.category === "Eating out")?.amount ?? 0;
  const eatUsual = typicalFor("Eating out", person);
  const pct = Math.round(((eat - eatUsual) / eatUsual) * 100);
  const series = sparkFor("Eating out", person);
  const max = Math.max(...series);

  const insights: { t: string; b: string; chart?: boolean }[] = [
    { t: `Eating out up ${pct}% vs usual`, b: `${gbp(eat, false)} this month against a usual ${gbp(eatUsual, false)}. Mostly weekday lunches and two dinners.`, chart: true },
    { t: "A subscription price went up", b: "Netflix is now £18.99, up from £17.99. That's £12 more a year." },
    { t: "New merchant", b: "Bao Borough, £46.80 on 18 Oct. First time we've seen it." },
    { t: "One big one-off this month", b: "Kingsley Napley, £1,850 for the lease review. Tagged one-off, so it won't skew your usual month." },
  ];
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
          This week you spent {gbp(week.thisWeek)}. {week.thisWeek < week.lastWeek ? "Quieter" : week.thisWeek > week.lastWeek ? "Busier" : "The same as"} {week.thisWeek === week.lastWeek ? "last week" : "than last week"} ({gbp(week.lastWeek)}) — groceries and the school run, nothing surprising.
        </p>
        <p className="mt-3 text-caption text-muted-foreground">Arrives Sunday evening.</p>
      </Panel>

      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        {insights.map((i, index) => (
          <Panel key={index}>
            <div className="flex items-center gap-2">
              {i.t === "New merchant" && <MerchantTile merchant="Bao Borough" category="Eating out" />}
              {i.t === "New merchant" && <Chip>New</Chip>}
              <h3 className="text-heading font-semibold">{i.t}</h3>
            </div>
            <p className="num mt-1.5 text-body leading-relaxed text-muted-foreground">{i.b}</p>
            {i.chart && (
              <div className="mt-5">
                <div className="flex h-20 items-end gap-2">
                  {series.map((v, k) => (
                    <div key={k} className="flex flex-1 flex-col items-center gap-1">
                      <div className={`chart-grow w-full rounded-t ${k === series.length - 1 ? "" : "opacity-40"}`} style={{ height: `${(v / max) * 64}px`, backgroundColor: CATEGORY_COLOR["Eating out"], animationDelay: `${k * 35}ms` }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex gap-2">
                  {MONTHS6.map((m) => <span key={m} className="flex-1 text-center text-micro text-muted-foreground">{m}</span>)}
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
