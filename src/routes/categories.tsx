import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { usePerson, PageTitle, Sheet, Sparkline, Label, meta } from "@/components/shell";
import { byCategory, spendTotal, TXNS, shareOf, sparkFor, typicalFor, gbp, MONTHS6, CATEGORY_COLOR, CATEGORIES } from "@/lib/data";
import { AnimatedBar } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { CategoryIcon } from "@/components/item-icons";
import { MerchantTile } from "@/components/tiles";

export const Route = createFileRoute("/categories")({
  head: () => meta("Categories", "October spending by category, with merchants and a six-month trend."),
  component: Categories,
});

function Categories() {
  const { person } = usePerson();
  const cats = byCategory(person);
  const max = cats[0]?.amount ?? 1;
  const [open, setOpen] = useState<(typeof CATEGORIES)[number] | null>(null);

  const merchants = open
    ? Object.entries(
        TXNS.filter((t) => t.kind === "spend" && t.category === open).reduce<Record<string, number>>((m, t) => {
          const v = shareOf(t, person);
          if (v > 0) m[t.merchant] = (m[t.merchant] ?? 0) + v;
          return m;
        }, {}),
      ).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div>
      <PageTitle sub={`${gbp(spendTotal(person))} in October`}>Categories</PageTitle>
      <div className="space-y-5 lg:grid lg:grid-cols-2 lg:gap-x-12 lg:gap-y-6 lg:space-y-0">
        {cats.map((c) => (
          <Button variant="ghost" key={c.category} onClick={() => setOpen(c.category)} className="panel-enter block h-auto w-full whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent">
            <div className="mb-1.5 flex justify-between text-body">
              <span className="relative flex items-center"><span className="absolute left-0 top-1/2 -translate-y-1/2"><CategoryIcon category={c.category} /></span><span className="pl-9">{c.category}</span></span>
              <span className="num amount">{gbp(c.amount, false)}</span>
            </div>
            <div className="h-2 rounded-lg bg-muted">
              <AnimatedBar percent={(c.amount / max) * 100} className="" colour={CATEGORY_COLOR[c.category]} />
            </div>
          </Button>
        ))}
      </div>

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div>
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-2 text-body text-muted-foreground"><CategoryIcon category={open} />{open}</div>
                <div className="num text-title font-semibold">{gbp(cats.find((c) => c.category === open)?.amount ?? 0, false)}</div>
                <div className="num text-caption text-muted-foreground">Usually {gbp(typicalFor(open, person), false)}</div>
              </div>
              <div className="text-right" style={{ color: CATEGORY_COLOR[open] }}>
                <Sparkline data={sparkFor(open, person)} className="" />
                <div className="text-micro text-muted-foreground">{MONTHS6[0]} – {MONTHS6[5]}</div>
              </div>
            </div>
            <div className="mt-6"><Label>Merchants</Label></div>
            {merchants.map(([m, v]) => (
              <div key={m} className="ledger-row flex items-center justify-between gap-3 py-2.5 text-body"><span className="flex min-w-0 items-center gap-2"><MerchantTile merchant={m} category={open} /><span>{m}</span></span><span className="num shrink-0">{gbp(v)}</span></div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
