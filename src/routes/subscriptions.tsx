import { createFileRoute } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Chip, Label, meta } from "@/components/shell";
import { SUBS, monthlyOf, yearlyOf, gbp, ownerName } from "@/lib/data";
import { MerchantTile } from "@/components/tiles";

export const Route = createFileRoute("/subscriptions")({
  head: () => meta("Subscriptions", "Recurring charges, yearly cost, and which card each one sits on."),
  component: Subs,
});

function Subs() {
  const { person } = usePerson();
  const list = SUBS.filter((s) => person === "household" || s.owner === person);
  const m = list.reduce((a, s) => a + monthlyOf(s), 0);
  const yearly = list.reduce((a, s) => a + yearlyOf(s), 0);
  const largest = [...list].sort((a, b) => yearlyOf(b) - yearlyOf(a))[0];
  return (
    <div>
      <PageTitle>Subscriptions</PageTitle>
      <Panel className="mb-6 grid grid-cols-2">
        <div><Label>Per month</Label><div className="num text-title font-semibold">{gbp(m)}</div></div>
        <div><Label>Per year</Label><div className="num text-title font-semibold">{gbp(m * 12, false)}</div></div>
        <div className="col-span-2 mt-4">
          <div className="flex h-2 overflow-hidden rounded-lg bg-muted" role="img" aria-label={list.map(s => `${s.name}: ${gbp(yearlyOf(s))} a year`).join("; ")}>
            {list.map((s, i) => <span key={s.name} className="h-full bg-primary" style={{ width: `${yearly > 0 ? yearlyOf(s) / yearly * 100 : 0}%`, opacity: 0.3 + (i % 5) * 0.14 }} />)}
          </div>
          {largest && <p className="num mt-2 text-caption text-muted-foreground">{largest.name} · {gbp(yearlyOf(largest))}/year</p>}
        </div>
      </Panel>
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        {list.map((s) => (
          <Panel key={s.name} className="p-4">
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
              {s.status.map((st) => <Chip key={st} tone={st === "Active" ? "good" : "warn"}>{st}</Chip>)}
            </div>
            <div className="mt-3 text-caption text-muted-foreground">
              {s.card} · last charged {s.last}{person === "household" && ` · ${ownerName(s.owner)}`}
              {s.note && <div className="mt-0.5">{s.note}</div>}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
