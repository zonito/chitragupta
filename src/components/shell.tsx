import { Link, useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Home, List, Sparkles, MoreHorizontal, ArrowUp, Sun, Moon, PieChart, Repeat, CreditCard, Upload, FileText, Calculator, Settings as Cog } from "lucide-react";
import { gbp, ocadoAnswer, tripAnswer, shareOf, dayLabel, currentMonthKey, currentMonthLabel, monthOptions, CATEGORY_COLOR, type Category, type Txn } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { DestinationIcon } from "@/components/item-icons";
import { MerchantTile } from "@/components/tiles";
import { useDocuments } from "@/components/documents";
import { searchRecords } from "@/lib/record-search";
import { parseAskQuery } from "@/lib/ask-query";
import { fetchApiTransactions } from "@/lib/txn-map";
import type { Person } from "@/lib/data";

const Ctx = createContext<{ person: Person; setPerson: (p: Person) => void }>({ person: "household", setPerson: () => {} });
export const usePerson = () => useContext(Ctx);

export function PersonProvider({ children }: { children: ReactNode }) {
  const [person, setPerson] = useState<Person>("household");
  return <Ctx.Provider value={{ person, setPerson }}>{children}</Ctx.Provider>;
}

const OPTS: { v: Person; l: string }[] = [
  { v: "household", l: "Household" },
  { v: "zonito", l: "Zonito" },
  { v: "nikhila", l: "Nikhila" },
];

export type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "chitragupta.theme";
const TCtx = createContext<{ theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; dark: boolean }>({ theme: "system", setTheme: () => {}, dark: false });
export const useTheme = () => useContext(TCtx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);
  const [sysDark, setSysDark] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") setTheme(v);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSysDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", on);
    setReady(true);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "dark" || (theme === "system" && sysDark);
  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.classList.toggle("dark", dark);
  }, [theme, dark, ready]);
  return <TCtx.Provider value={{ theme, setTheme, dark }}>{children}</TCtx.Provider>;
}

/** Runs before paint so the saved theme never flashes. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}")||"system";if(t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export function ThemeToggle() {
  const { dark, setTheme } = useTheme();
  return (
    <button
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground transition hover:text-foreground"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function PersonSwitch() {
  const { person, setPerson } = usePerson();
  return (
    <div className="grid grid-cols-3 rounded-full bg-muted p-1 text-sm">
      {OPTS.map((o) => (
        <button
          key={o.v}
          onClick={() => setPerson(o.v)}
          className={`rounded-full py-1.5 transition ${person === o.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

const SIDE = [
  { to: "/", l: "Home", I: Home },
  { to: "/activity", l: "Activity", I: List },
  { to: "/coach", l: "Coach", I: Sparkles },
  { to: "/categories", l: "Categories", I: PieChart },
  { to: "/subscriptions", l: "Subscriptions", I: Repeat },
  { to: "/cards", l: "Cards", I: CreditCard },
  { to: "/import", l: "Import", I: Upload },
  { to: "/receipts", l: "Receipts & documents", I: FileText },
  { to: "/calculators", l: "Calculators", I: Calculator },
  { to: "/settings", l: "Settings", I: Cog },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs = [
    { to: "/", l: "Home", I: Home, on: path === "/" },
    { to: "/activity", l: "Activity", I: List, on: path.startsWith("/activity") },
    { to: "/coach", l: "Coach", I: Sparkles, on: path.startsWith("/coach") },
    { to: "/more", l: "More", I: MoreHorizontal, on: !["/", "/activity", "/coach"].some((p) => p === path || (p !== "/" && path.startsWith(p))) },
  ] as const;
  return (
    <div className="mx-auto min-h-screen max-w-md lg:flex lg:max-w-none">
      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col gap-6 border-r bg-card/60 px-6 py-8 lg:flex">
        <div className="flex items-center justify-between">
          <span className="brand-wordmark flex items-center gap-2 font-display text-2xl italic text-primary"><Logo size={28} />Chitragupta</span>
          <ThemeToggle />
        </div>
        <div>
          <div className="mb-2 text-xs text-muted-foreground">{currentMonthLabel()}</div>
          <PersonSwitch />
        </div>
        <nav className="-mx-2 flex flex-col gap-0.5 overflow-y-auto">
          {SIDE.map(({ to, l }) => {
            const on = to === "/" ? path === "/" : path.startsWith(to);
            return (
              <Link key={to} to={to} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${on ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <DestinationIcon to={to} />
                {l}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 bg-background/95 px-5 pt-5 pb-3 backdrop-blur lg:hidden">
          <div className="mb-3 flex items-center justify-between">
            <span className="brand-wordmark flex items-center gap-2 font-display text-xl italic text-primary"><Logo size={24} />Chitragupta</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{currentMonthLabel()}</span>
              <ThemeToggle />
            </div>
          </div>
          <PersonSwitch />
        </header>
        <main key={path} className="route-content px-5 pb-44 pt-2 lg:mx-auto lg:max-w-[1060px] lg:px-10 lg:pb-32 lg:pt-10">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t bg-card/95 backdrop-blur lg:hidden">
        <div className="grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
          {tabs.map(({ to, l, I, on }) => (
            <Link key={to} to={to} className={`flex flex-col items-center gap-1 py-3 text-caption ${on ? "text-primary" : "text-muted-foreground"}`}>
              <I className="h-5 w-5" strokeWidth={on ? 2.2 : 1.6} />
              {l}
            </Link>
          ))}
        </div>
      </nav>
      <AskButton />
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6 mt-2">
      <h1 className="text-title font-semibold">{children}</h1>
      {sub && <p className="num mt-1 text-caption leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border bg-card p-5 shadow-panel ${className}`}>{children}</section>;
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-micro font-medium uppercase tracking-[0.08em] text-muted-foreground">{children}</div>;
}

const CHIP: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-good/15 text-good",
  warn: "bg-warn/15 text-warn",
  bad: "bg-destructive/12 text-destructive",
};
export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof CHIP }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium ${CHIP[tone]}`}>{children}</span>;
}
export function CategoryChip({ category }: { category: Category }) {
  if (category === "Transfer" || category === "Moved aside") return <Chip tone={category === "Moved aside" ? "good" : "neutral"}>{category}</Chip>;
  const colour = CATEGORY_COLOR[category];
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium" style={{ color: colour, backgroundColor: `color-mix(in oklab, ${colour} 12%, transparent)` }}>{category}</span>;
}

export function Row({ left, sub, right, onClick }: { left: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void }) {
  const C = onClick ? "button" : "div";
  return (
    <C onClick={onClick} className="ledger-row flex w-full items-center justify-between gap-3 py-3 text-left">
      <div className="min-w-0">
        <div className="truncate text-body">{left}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
    </C>
  );
}

export function Sparkline({ data, w = 120, h = 32, className = "text-primary" }: { data: number[]; w?: number; h?: number; className?: string }) {
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  const last = pts.split(" ").at(-1)?.split(",") ?? ["0", "0"];
  return (
    <svg width={w} height={h} className={className}>
      <polyline className="trend-draw" pathLength={1} points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" />
    </svg>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 dark:bg-background/70 lg:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-xl border-t bg-card p-6 pb-10 lg:max-w-lg lg:rounded-xl lg:border lg:pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-border" />
        {children}
      </div>
    </div>
  );
}

export const meta = (title: string, description: string) => ({
  meta: [
    { title: `${title} · Chitragupta` },
    { name: "description", content: description },
    { property: "og:title", content: `${title} · Chitragupta` },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ],
});

const TRIP_QUESTION = "What have holidays cost this month?";
const OCADO_QUESTION = "How much on Ocado this month?";
const BOILER_QUESTION = "When did we last get the boiler serviced?";
const WARRANTY_QUESTION = "When does the washing machine warranty end?";
const INDIA_QUESTION = "What did we spend in India in August?";
const EXAMPLES = ["How much on groceries this year?", INDIA_QUESTION, WARRANTY_QUESTION, TRIP_QUESTION, OCADO_QUESTION, BOILER_QUESTION];

export function AskButton() {
  const { person } = usePerson();
  const { documents } = useDocuments();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [workedExample, setWorkedExample] = useState<"ocado" | "trip" | "records">("ocado");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Full-history search state: the snapshot only carries two months, so
  // records questions fetch matching rows from /api/transactions.
  const [history, setHistory] = useState<{ question: string; txns: Txn[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const isTrip = workedExample === "trip";
  const answer = isTrip ? tripAnswer(person) : ocadoAnswer(person);

  const runHistorySearch = async (question: string) => {
    const plan = parseAskQuery(question, currentMonthKey());
    setSearching(true);
    setSearchFailed(false);
    setHistory(null);
    try {
      const params: Record<string, string> = { limit: "1000" };
      if (plan.month) params["month"] = plan.month;
      if (plan.category) params["category"] = plan.category;
      else if (plan.apiQuery) params["q"] = plan.apiQuery;
      const txns = await fetchApiTransactions(params);
      setHistory({ question, txns });
    } catch {
      setSearchFailed(true);
    } finally {
      setSearching(false);
    }
  };

  const submitQuestion = (question: string) => {
    if (!question.trim()) return;
    setExpanded(null);
    if (/ocado/i.test(question) && !/last|receipt|document/i.test(question)) setWorkedExample("ocado");
    else if (/holiday/i.test(question) && /cost|spend|spent|total/i.test(question)) setWorkedExample("trip");
    else {
      const trimmed = question.trim();
      setSubmittedQuestion(trimmed);
      setWorkedExample("records");
      void runHistorySearch(trimmed);
    }
  };

  // Records answers search the fetched full-history rows once they land;
  // before that (or if the fetch failed) the snapshot search runs, which
  // only sees the current month. Month-scoped questions never fall back
  // to a different month's records.
  const plan = workedExample === "records" && submittedQuestion
    ? parseAskQuery(submittedQuestion, currentMonthKey())
    : null;
  const historyRows = history && history.question === submittedQuestion ? history.txns : null;
  let recordAnswer = searchRecords(submittedQuestion, person, documents);
  let usedHistory = false;
  if (historyRows) {
    const scoped = searchRecords(
      plan && plan.terms.length > 0 ? plan.terms.join(" ") : submittedQuestion,
      person,
      documents,
      historyRows,
    );
    if (plan?.month || scoped.records.length > 0 || recordAnswer.records.length === 0) {
      recordAnswer = scoped;
      usedHistory = true;
    }
  }
  const latest = recordAnswer.latest;
  const matchedTxns = usedHistory && plan?.month
    ? [...new Map(recordAnswer.records.filter((r) => r.transaction).map((r) => [r.transaction!.id, r.transaction!] as const)).values()]
    : [];
  const monthTotal = matchedTxns.reduce((s, t) => s + shareOf(t, person), 0);
  const monthLabel = plan?.month ? (monthOptions().find((m) => m.key === plan.month)?.label ?? plan.month) : "";
  const monthOnly = Boolean(usedHistory && plan?.month && plan.terms.length === 0);
  const monthOnlyRows = monthOnly && historyRows
    ? historyRows.filter((t) => t.kind === "spend" && shareOf(t, person) > 0)
    : [];
  const monthOnlyTotal = monthOnlyRows.reduce((s, t) => s + shareOf(t, person), 0);
  const noHolidays = isTrip && answer.orders.length === 0;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 mx-auto flex max-w-md justify-end px-5 lg:bottom-8 lg:max-w-none lg:px-8">
        <button
          onClick={() => setOpen(true)}
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-accent px-5 py-3 text-body font-medium text-accent-foreground shadow-panel"
        >
          <Sparkles className="h-4 w-4" /> Ask
        </button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="max-h-[75vh] overflow-y-auto">
          <h2 className="mb-4 text-heading font-semibold">Ask about your spending</h2>
          <form onSubmit={(e) => { e.preventDefault(); submitQuestion(q); }} className="relative mb-4">
            <input aria-label="Question about your records" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your money…" className="w-full rounded-xl border bg-card py-3 pl-4 pr-12 text-body outline-none focus:ring-2 focus:ring-ring" />
            <Button aria-label="Send" size="icon" className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg bg-primary text-primary-foreground"><ArrowUp className="h-4 w-4" /></Button>
          </form>
          <div className="mb-6 flex flex-wrap gap-2">
            {EXAMPLES.map((e) => <Button key={e} variant="outline" onClick={() => {
              setQ(e);
              if (e === TRIP_QUESTION) setWorkedExample("trip");
              if (e === OCADO_QUESTION) setWorkedExample("ocado");
              if (e === BOILER_QUESTION || e === WARRANTY_QUESTION || e === INDIA_QUESTION) submitQuestion(e);
            }} className="h-auto whitespace-normal rounded-lg border bg-card px-3 py-1.5 text-left text-xs font-normal text-muted-foreground shadow-none">{e}</Button>)}
          </div>
          <Label>You asked</Label>
          <p className="mb-3 text-body leading-relaxed">"{workedExample === "records" ? submittedQuestion : isTrip ? TRIP_QUESTION : OCADO_QUESTION}"</p>
          {workedExample === "records" ? (
            searching ? (
              <Panel>
                <p className="num text-body leading-relaxed">Searching your records…</p>
              </Panel>
            ) : monthOnly ? (
              <Panel>
                <div className="num text-title font-semibold">{gbp(monthOnlyTotal)}</div>
                <p className="mb-4 text-caption leading-relaxed text-muted-foreground">Spent in {monthLabel} across {monthOnlyRows.length} {monthOnlyRows.length === 1 ? "transaction" : "transactions"}.</p>
                {monthOnlyRows.slice(0, 8).map((t) => (
                  <div key={t.id} className="ledger-row flex justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0"><span className="block">{t.merchant}</span><span className="mt-0.5 block text-xs text-muted-foreground">{dayLabel(t.day, true, t.monthKey)}</span></span>
                    <span className="num shrink-0">{gbp(shareOf(t, person))}</span>
                  </div>
                ))}
              </Panel>
            ) : (
            <Panel>
              {searchFailed && <p className="mb-3 text-caption leading-relaxed text-muted-foreground">Full history could not be searched just now — showing this month only.</p>}
              <div aria-live="polite" className="num text-body leading-relaxed">
                {latest ? recordAnswer.warrantyQuestion
                  ? latest.document?.warrantyEnds ? `The recorded warranty ends ${latest.document.warrantyEnds}.` : "The matching records do not include a warranty end date."
                  : `The latest matching record is ${latest.merchant}, dated ${latest.date} — ${gbp(latest.amount)}${person !== "household" && latest.transaction?.owner === "joint" ? " (your share)" : ""}.`
                  : `No matching transactions or documents in ${person === "household" ? "the household" : "your"} records. This does not mean it never happened; it is not recorded here.`}
              </div>
              {usedHistory && plan?.month && matchedTxns.length > 0 && (
                <p className="num mt-2 text-body leading-relaxed">Total in {monthLabel}: {gbp(monthTotal)} across {matchedTxns.length} {matchedTxns.length === 1 ? "transaction" : "transactions"}.</p>
              )}
              {usedHistory && plan?.month && recordAnswer.records.length === 0 && (
                <p className="num mt-2 text-body leading-relaxed">Total in {monthLabel}: {gbp(0)}.</p>
              )}
              {latest && (
                <div className="mt-4">
                  <Label>Matching records</Label>
                  {recordAnswer.records.map((record) => (
                    <div key={record.id} className="ledger-row py-3">
                      <div className="flex items-start gap-3">
                        <MerchantTile merchant={record.merchant} category={record.transaction?.category ?? (record.document?.type === "Warranty" || record.document?.type === "Bill" ? "Home" : "Shopping")} />
                        <div className="min-w-0 flex-1">
                          <div className="text-body">{record.merchant}</div>
                          <div className="text-caption text-muted-foreground">{record.date} · {record.transaction ? "Transaction" : record.document?.type}{record.transaction && record.document ? ` + ${record.document.type.toLowerCase()}` : ""}</div>
                        </div>
                        <span className="num shrink-0 text-body font-medium">{gbp(record.amount)}</span>
                      </div>
                      <Button variant="ghost" size="sm" aria-expanded={expanded === record.id} onClick={() => setExpanded(expanded === record.id ? null : record.id)} className="mt-1 text-caption">{expanded === record.id ? "Hide record" : "View record"}</Button>
                      {expanded === record.id && (
                        <dl className="num mt-2 space-y-2 text-caption">
                          {record.transaction && <><div><dt className="text-muted-foreground">Account</dt><dd>{record.transaction.account}</dd></div>{record.transaction.note && <div><dt className="text-muted-foreground">Note</dt><dd>{record.transaction.note}</dd></div>}{person !== "household" && record.transaction.owner === "joint" && <div><dt className="text-muted-foreground">Full bill</dt><dd>{gbp(record.transaction.amount)}</dd></div>}</>}
                          {record.document && <><div><dt className="text-muted-foreground">File</dt><dd className="break-all">{record.document.path.split("/").at(-1)}</dd></div><div><dt className="text-muted-foreground">Filed at</dt><dd className="break-all">{record.document.path}</dd></div>{record.document.warrantyEnds && <div><dt className="text-muted-foreground">Warranty ends</dt><dd>{record.document.warrantyEnds}</dd></div>}</>}
                        </dl>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            )
          ) : <Panel>
            {answer.fallback && !noHolidays && <Label>Household answer</Label>}
            <div className="num text-title font-semibold">{gbp(answer.total, !isTrip)}</div>
            <p className="mb-4 text-caption leading-relaxed text-muted-foreground">{noHolidays ? "No Holidays charges this month." : answer.fallback ? "Nothing on your own accounts — this is the household picture." : isTrip ? `${answer.orders.length} ${answer.orders.length === 1 ? "booking" : "bookings"} in Holidays this month.` : `${answer.orders.length} orders this month.`}</p>
            {answer.orders.map((t) => (
              <div key={t.id} className="ledger-row flex justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">{isTrip ? <><span className="block">{t.merchant}</span><span className="mt-0.5 block text-xs text-muted-foreground">{dayLabel(t.day)}</span></> : dayLabel(t.day)}</span>
                <span className="num shrink-0">{gbp(shareOf(t, answer.answerPerson))}</span>
              </div>
            ))}
          </Panel>}
        </div>
      </Sheet>
    </>
  );
}
