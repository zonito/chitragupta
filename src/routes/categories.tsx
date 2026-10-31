import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePerson, PageTitle, Sheet, Sparkline, Label, meta } from "@/components/shell";
import { byCategory, spendTotal, TXNS, shareOf, sparkFor, typicalFor, gbp, currentMonthName, currentMonthKey, monthOptions, MONTHS6, CATEGORY_COLOR, CATEGORIES, type Category } from "@/lib/data";
import { fetchCategoryMerchants, fetchCategoryScope, scopeLabel, scopeOptions, type CategoryScopeData } from "@/lib/category-scope";
import { AnimatedBar } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { CategoryIcon } from "@/components/item-icons";
import { MerchantTile } from "@/components/tiles";

export const Route = createFileRoute("/categories")({
  head: () => meta("Categories", "Spending by category this month, with merchants and a six-month trend."),
  component: Categories,
});

const sel = "rounded-lg border bg-card px-3 py-1.5 text-body";

export function Categories() {
  const { person } = usePerson();
  const months = monthOptions();
  const defaultScope = `month:${currentMonthKey()}`;
  const [scope, setScope] = useState(defaultScope);
  const isDefault = scope === defaultScope;
  const [open, setOpen] = useState<Category | null>(null);

  // Fetched scopes (anything but the current month) come from the scoped
  // aggregates API and are cached per person + scope for the session.
  // The default current-month view never fetches: it renders the
  // snapshot exactly as before.
  const cacheKey = `${person}|${scope}`;
  const [fetched, setFetched] = useState<Record<string, CategoryScopeData>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const data = isDefault ? undefined : fetched[cacheKey];
  const loadFailed = !isDefault && (failed[cacheKey] ?? false);

  useEffect(() => {
    if (isDefault || fetched[cacheKey] || failed[cacheKey]) return;
    let cancelled = false;
    fetchCategoryScope(scope, person)
      .then((d) => {
        if (!cancelled) setFetched((prev) => ({ ...prev, [cacheKey]: d }));
      })
      .catch(() => {
        if (!cancelled) setFailed((prev) => ({ ...prev, [cacheKey]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, scope, person, isDefault, fetched, failed]);

  const snapshotCats = byCategory(person);
  const cats: { category: Category; amount: number }[] = isDefault
    ? snapshotCats
    : (data?.rows ?? []).map((r) => ({ category: r.category, amount: r.amount }));
  const max = cats[0]?.amount ?? 1;
  const label = scopeLabel(scope, months);

  const snapshotMerchants =
    open && isDefault
      ? Object.entries(
          TXNS.filter((t) => t.kind === "spend" && t.category === open).reduce<Record<string, number>>((m, t) => {
            const v = shareOf(t, person);
            if (v > 0) m[t.merchant] = (m[t.merchant] ?? 0) + v;
            return m;
          }, {}),
        ).sort((a, b) => b[1] - a[1])
      : [];

  // The sheet's merchant breakdown for a fetched scope comes from the
  // API's merchant mode, keyed so a stale response never renders.
  const merchantKey = open ? `${cacheKey}|${open}` : "";
  const [apiMerchants, setApiMerchants] = useState<{
    key: string;
    list: { merchant: string; amount: number }[];
  } | null>(null);
  useEffect(() => {
    if (isDefault || !open) return;
    let cancelled = false;
    fetchCategoryMerchants(scope, person, open)
      .then((list) => {
        if (!cancelled) setApiMerchants({ key: merchantKey, list });
      })
      .catch(() => {
        if (!cancelled) setApiMerchants({ key: merchantKey, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [merchantKey, scope, person, open, isDefault]);
  const merchants: [string, number][] = isDefault
    ? snapshotMerchants
    : apiMerchants?.key === merchantKey
      ? apiMerchants.list.map((m) => [m.merchant, m.amount] as [string, number])
      : [];
  const merchantsLoading = !isDefault && !!open && apiMerchants?.key !== merchantKey;

  const fetchedRow =
    !isDefault && open ? data?.rows.find((r) => r.category === open) : undefined;
  const sheetAmount = isDefault
    ? (snapshotCats.find((c) => c.category === open)?.amount ?? 0)
    : (fetchedRow?.amount ?? 0);
  const sheetTypical = isDefault
    ? open
      ? typicalFor(open, person)
      : 0
    : (fetchedRow?.typical ?? null);
  const sheetSeries = isDefault
    ? open
      ? sparkFor(open, person)
      : []
    : (fetchedRow?.series ?? []);
  const sheetCaption = isDefault
    ? `${MONTHS6[0] ?? ""} – ${MONTHS6[5] ?? ""}`
    : `${data?.seriesLabels[0] ?? ""} – ${data?.seriesLabels.at(-1) ?? ""}`;

  const sub = isDefault
    ? `${gbp(spendTotal(person))} in ${currentMonthName()}`
    : loadFailed
      ? `Could not load ${label}`
      : !data
        ? "Loading…"
        : cats.length === 0
          ? `No spending in ${label}`
          : `${gbp(data.total)} in ${label}`;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <PageTitle sub={sub}>Categories</PageTitle>
        {months.length > 0 && (
          <select
            className={`${sel} mt-2 shrink-0`}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setOpen(null);
            }}
            aria-label="Period"
          >
            {scopeOptions(months).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {!isDefault && !data && !loadFailed && (
        <p className="py-12 text-center text-body text-muted-foreground">Loading…</p>
      )}
      {loadFailed && (
        <p className="py-12 text-center text-body text-muted-foreground">
          Could not load that period.
        </p>
      )}
      {!isDefault && data && cats.length === 0 && (
        <p className="py-12 text-center text-body text-muted-foreground">
          No spending in {label}.
        </p>
      )}

      {(isDefault || data) && cats.length > 0 && (
        <div className="space-y-5 lg:grid lg:grid-cols-2 lg:gap-x-12 lg:gap-y-6 lg:space-y-0">
          {cats.map((c) => (
            <Button variant="ghost" key={c.category} onClick={() => setOpen(c.category)} className="panel-enter block h-auto w-full whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent hover:text-foreground">
              <div className="mb-1.5 flex justify-between text-body">
                <span className="relative flex items-center"><span className="absolute left-0 top-1/2 -translate-y-1/2"><CategoryIcon category={c.category} /></span><span className="pl-9">{c.category}</span></span>
                <span className="num amount">{gbp(c.amount, false)}</span>
              </div>
              <div className="h-2 rounded-lg bg-muted">
                <AnimatedBar percent={(c.amount / max) * 100} className="" colour={CATEGORY_COLOR[c.category as (typeof CATEGORIES)[number]]} />
              </div>
            </Button>
          ))}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div>
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-2 text-body text-muted-foreground"><CategoryIcon category={open} />{open}</div>
                <div className="num text-title font-semibold">{gbp(sheetAmount, false)}</div>
                {isDefault ? (
                  <div className="num text-caption text-muted-foreground">Usually {gbp(sheetTypical as number, false)}</div>
                ) : (
                  sheetTypical !== null && sheetTypical > 0 && (
                    <div className="num text-caption text-muted-foreground">Usually {gbp(sheetTypical, false)}</div>
                  )
                )}
              </div>
              {(isDefault || sheetSeries.length >= 2) && (
                <div className="text-right" style={{ color: CATEGORY_COLOR[open as (typeof CATEGORIES)[number]] }}>
                  <Sparkline data={sheetSeries} className="" />
                  <div className="text-micro text-muted-foreground">{sheetCaption}</div>
                </div>
              )}
            </div>
            <div className="mt-6"><Label>Merchants</Label></div>
            {merchantsLoading && (
              <p className="py-4 text-body text-muted-foreground">Loading…</p>
            )}
            {merchants.map(([m, v]) => (
              <div key={m} className="ledger-row flex items-center justify-between gap-3 py-2.5 text-body"><span className="flex min-w-0 items-center gap-2"><MerchantTile merchant={m} category={open} /><span>{m}</span></span><span className="num shrink-0">{gbp(v)}</span></div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
