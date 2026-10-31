import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageTitle, Panel, Label, meta } from "@/components/shell";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { gbp, TXNS, currentMonthLabel } from "@/lib/data";
import { calculatorDefaults, CALCULATOR_STORAGE_KEY, restoreCalculators, costPerUse, habitTotals, subscriptionTotals, priceRise, costPerDay, smallSpendFact, type CalculatorState } from "@/lib/calculators";
import { SettlingValue } from "@/components/motion";

export const Route = createFileRoute("/calculators")({
  head: () => meta("Calculators", "Handy money maths: cost per use, small spends, subscriptions, price rises and cost per day."),
  component: Calculators,
});

function NumberControl({ id, label, value, onChange, min = 0, max, step = 0.01, money = false, slider = false }: {
  id: string; label: string; value: number; onChange: (value: number) => void;
  min?: number; max?: number; step?: number; money?: boolean; slider?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const clamp = (n: number) => Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, n));
  return <div className="space-y-3">
    <label htmlFor={id} className="block text-caption text-muted-foreground">{label}</label>
    <div className="relative">
      {money && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">£</span>}
      <Input id={id} type="number" inputMode={step === 1 ? "numeric" : "decimal"} min={min} max={max} step={step} value={draft}
        className={`num h-11 bg-background text-base md:text-base ${money ? "pl-7" : ""}`}
        onChange={e => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= min && (max === undefined || n <= max)) onChange(step === 1 ? Math.round(n) : n);
        }}
        onBlur={() => { const n = clamp(Number(draft)); const next = step === 1 ? Math.round(n) : n; setDraft(String(next)); onChange(next); }} />
    </div>
    {slider && <Slider aria-label={`${label} slider`} min={min} max={max ?? Math.max(500, value)} step={step} value={[value]} className="h-6" onValueChange={values => { const n = values[0]; if (n !== undefined) onChange(n); }} />}
  </div>;
}

function Results({ items }: { items: { label: string; value: number | null }[] }) {
  return <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t pt-4">
    {items.map(item => <div key={item.label} className="min-w-0"><dt className="text-caption text-muted-foreground">{item.label}</dt><dd className="num mt-1 break-words text-heading font-semibold"><SettlingValue value={item.value} /></dd></div>)}
  </dl>;
}

function Calculators() {
  const [state, setState] = useState<CalculatorState>(calculatorDefaults);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try { setState(restoreCalculators(localStorage.getItem(CALCULATOR_STORAGE_KEY))); } catch { /* Keep inputs usable without storage. */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(CALCULATOR_STORAGE_KEY, JSON.stringify(state)); } catch { /* Storage is optional. */ }
  }, [state, loaded]);
  const update = (key: keyof CalculatorState) => (value: number) => setState(s => ({ ...s, [key]: value }));
  const perUse = costPerUse(state.usePrice, state.uses);
  const habit = habitTotals(state.habit, state.frequency);
  const subscription = subscriptionTotals(state.subscription);
  const rise = priceRise(state.oldPrice, state.newPrice);
  const daily = costPerDay(state.dayPrice, state.years);
  const fact = smallSpendFact(TXNS);

  return <div>
    <PageTitle>Calculators</PageTitle>
    <div className="space-y-5">
      <Panel>
        <Label>01 · Cost per use</Label>
        <h2 className="mb-5 text-heading font-semibold">Make every wear count</h2>
        <div className="grid grid-cols-2 gap-4">
          <NumberControl id="use-price" label="Price" value={state.usePrice} onChange={update("usePrice")} money />
          <NumberControl id="uses" label="Times used" value={state.uses} onChange={update("uses")} min={1} step={1} slider />
        </div>
        <div className="mt-5 border-t pt-5">
          <div className="text-caption text-muted-foreground">Cost per use</div>
          <output className="num mt-1 block break-words text-title font-semibold text-foreground"><SettlingValue value={perUse} /></output>
          <p className="num mt-2 text-body leading-relaxed text-muted-foreground">{gbp(state.usePrice, state.usePrice % 1 !== 0)} boots worn {state.uses} times = {perUse === null ? "—" : gbp(perUse)} per wear.</p>
        </div>
      </Panel>

      <Panel>
        <Label>02 · Small spends add up</Label>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <NumberControl id="habit" label="Habit amount" value={state.habit} onChange={update("habit")} min={1} max={20} step={0.5} money slider />
          <NumberControl id="frequency" label="Times per week" value={state.frequency} onChange={update("frequency")} max={50} step={1} slider />
        </div>
        <Results items={[{ label: "Per month", value: habit.month }, { label: "Per year", value: habit.year }, { label: "Over 5 years", value: habit.fiveYears }]} />
        <p className="mt-3 text-caption text-muted-foreground">52 weeks a year · monthly average</p>
        <aside className="mt-5 border-t pt-4 text-body leading-relaxed">
          <Label>Household · {currentMonthLabel()}</Label>
          Small spends under £10 this month: <span className="num font-medium">{gbp(fact.total)}</span> across {fact.count} spends.
        </aside>
      </Panel>

      <Panel>
        <Label>03 · True cost of a subscription</Label>
        <div className="mt-4"><NumberControl id="subscription" label="Monthly price" value={state.subscription} onChange={update("subscription")} money /></div>
        <Results items={[{ label: "Per year", value: subscription.year }, { label: "Over 5 years", value: subscription.fiveYears }]} />
        <div className="mt-5 border-t pt-4">
          <Label>Illustration only</Label>
          <p className="num text-body leading-relaxed">{gbp(state.subscription)} moved aside each month becomes <span className="num font-medium text-foreground">{gbp(subscription.savings)}</span> after 5 years at a sample 4% a year.</p>
          <p className="num mt-2 text-caption leading-relaxed text-muted-foreground">Monthly deposits, made at month end. Interest compounded monthly; no tax or fees included.</p>
        </div>
      </Panel>

      <Panel>
        <Label>04 · Price rise impact</Label>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <NumberControl id="old-price" label="Old monthly price" value={state.oldPrice} onChange={update("oldPrice")} money />
          <NumberControl id="new-price" label="New monthly price" value={state.newPrice} onChange={update("newPrice")} money />
        </div>
        <div className="mt-5 text-caption text-muted-foreground">Percentage rise</div>
        <output className="num mt-1 block text-title font-semibold"><SettlingValue value={rise.percent} format={value => `${value.toFixed(2)}%`} /></output>
        <Results items={[{ label: "Extra per month", value: rise.month }, { label: "Extra per year", value: rise.year }]} />
      </Panel>

      <Panel>
        <Label>05 · Cost per day</Label>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <NumberControl id="day-price" label="Price" value={state.dayPrice} onChange={update("dayPrice")} money />
          <NumberControl id="years" label="Years kept" value={state.years} onChange={update("years")} min={1} max={30} step={1} slider />
        </div>
        <Results items={[{ label: "Per day", value: daily.day }, { label: "Per month", value: daily.month }]} />
        <p className="mt-3 text-caption text-muted-foreground">365 days a year · monthly average</p>
      </Panel>
    </div>
  </div>;
}