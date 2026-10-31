import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageTitle, Panel, Label, Chip, Row, Sheet, meta, useTheme, type ThemeChoice } from "@/components/shell";
import { ACCOUNTS, appSettings, categoryColor, categoryDefs, reviewTotal, type Category, type CategoryDef, type ReviewQueueItem } from "@/lib/data";
import { AccountTile, MerchantTile } from "@/components/tiles";
import { CategoryIcon } from "@/components/item-icons";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/settings")({
  head: () => meta("Settings", "People, accounts, currency and digest preferences."),
  component: Settings,
});

const PAGE_SIZE = 20;
const sel = "rounded-lg border bg-card px-3 py-1.5 text-body";

export function Settings() {
  const { theme, setTheme } = useTheme();
  const accs = (o: string) => ACCOUNTS.filter((a) => a.owner === o);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [status, setStatus] = useState<Record<string, "kept" | "dismissed">>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const waiting = reviewTotal();
  const queue = items.filter((m) => !status[m.merchant]);
  const handled = items.filter((m) => status[m.merchant]);
  const remaining = Math.max(0, total - handled.length);

  // The sheet fetches the real queue on open (the snapshot carries only
  // the true total, for the header chip), so it can page through every
  // waiting merchant instead of a baked-in handful.
  useEffect(() => {
    if (!reviewOpen) return;
    let cancelled = false;
    setVisible(PAGE_SIZE);
    setStatus({});
    setLoaded(false);
    fetch("/api/review-queue")
      .then((res) => res.json())
      .then((body: { ok?: boolean; queue?: ReviewQueueItem[]; total?: number }) => {
        if (cancelled) return;
        if (body.ok && body.queue) {
          setItems(body.queue);
          setTotal(body.total ?? body.queue.length);
          setChoices(
            Object.fromEntries(
              body.queue
                .filter((item) => item.suggestion)
                .map((item) => [item.merchant, item.suggestion as string]),
            ),
          );
        } else {
          setItems([]);
          setTotal(0);
          setChoices({});
        }
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setChoices({});
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewOpen]);

  const keep = (item: ReviewQueueItem) => {
    const category = choices[item.merchant];
    if (!category) return;
    setStatus((s) => ({ ...s, [item.merchant]: "kept" }));
    // Keeping confirms the chosen category in merchant memory (a "user"
    // correction), so the choice survives reloads and future imports
    // classify the merchant the same way.
    void fetch("/api/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: item.merchant, category, source: "user" }),
    }).catch(() => {});
  };

  const dismiss = (item: ReviewQueueItem) => {
    setStatus((s) => ({ ...s, [item.merchant]: "dismissed" }));
    // Dismissal persists server-side (its own table, never merchant
    // memory), so the merchant does not come back on reload.
    void fetch("/api/review-queue/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: item.merchant }),
    }).catch(() => {});
  };

  const tileCategory = (item: ReviewQueueItem): Category =>
    (choices[item.merchant] as Category | undefined) ??
    (item.suggestion as Category | null) ??
    "One-off";

  return (
    <div className="space-y-5 lg:max-w-2xl">
      <PageTitle>Settings</PageTitle>
      <Panel className="py-2">
        <Label>People & accounts</Label>
        {([["Zonito", "zonito"], ["Nikhila", "nikhila"], ["Joint", "joint"]] as const).map(([n, owner]) => (
          <div key={n} className="ledger-row py-3"><div>{n}</div><div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-caption text-muted-foreground">{accs(owner).map((a, index) => <span key={a.name} className="inline-flex items-center gap-2"><AccountTile account={a.name} /><span>{a.name}{index < accs(owner).length - 1 ? "," : ""}</span></span>)}</div></div>
        ))}
      </Panel>
      <Panel className="py-2">
        <div className="ledger-row flex items-center justify-between gap-3 py-3">
          <span>Theme</span>
          <div className="grid grid-cols-3 rounded-full bg-muted p-1 text-caption" role="radiogroup" aria-label="Theme">
            {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
              <button key={t} role="radio" aria-checked={theme === t} onClick={() => setTheme(t)} className={`rounded-full px-3 py-1 capitalize transition ${theme === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{t}</button>
            ))}
          </div>
        </div>
        {[["Display currency", "GBP £"], ["Weekly digest", "Sunday evening"]].map(([k, v]) => (
          <div key={k} className="ledger-row flex justify-between py-3"><span>{k}</span><span className="text-muted-foreground">{v}</span></div>
        ))}
        <Row
          left="Merchant review"
          onClick={() => setReviewOpen(true)}
          right={<Chip tone="neutral">{waiting === 0 ? "Review queue is clear" : `${waiting} ${waiting === 1 ? "merchant" : "merchants"} waiting for review`}</Chip>}
        />
      </Panel>
      <CategoriesManager />
      <FloorsBudgets />
      <p className="px-1 text-body leading-relaxed text-muted-foreground">
        Your data stays with you. Transfers between Zonito and Nikhila are never counted as spending, and money moved to savings or investments shows separately as "Moved aside".
      </p>
      <p className="px-1 text-body text-muted-foreground">Statements live in Drive; aggregates are precomputed.</p>

      <Sheet open={reviewOpen} onClose={() => setReviewOpen(false)}>
        <h2 className="mb-1 text-heading font-semibold">Merchant review</h2>
        <p className="mb-4 text-body leading-relaxed text-muted-foreground">Merchants we haven't seen before. Pick a category and keep to confirm it; dismissing marks it as noise.</p>
        {!loaded && <p className="py-2 text-caption text-muted-foreground">Loading…</p>}
        {loaded && (
          <p className="mb-2 text-caption text-muted-foreground">
            {remaining === 0 ? "Nothing waiting." : `${remaining} ${remaining === 1 ? "merchant" : "merchants"} waiting for review.`}
          </p>
        )}
        <div>
          {queue.slice(0, visible).map((m) => (
            <div key={m.merchant} className="ledger-row flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantTile merchant={m.merchant} category={tileCategory(m)} />
                <div className="min-w-0">
                  <div className="truncate text-body">{m.merchant}</div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{m.detail}</div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <select
                  aria-label={`Category for ${m.merchant}`}
                  className={sel}
                  value={choices[m.merchant] ?? ""}
                  onChange={(e) => setChoices((prev) => ({ ...prev, [m.merchant]: e.target.value }))}
                >
                  <option value="" disabled>Choose a category</option>
                  {categoryDefs().map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <Button variant="outline" size="sm" disabled={!choices[m.merchant]} onClick={() => keep(m)}>Keep</Button>
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => dismiss(m)}>Dismiss</Button>
              </div>
            </div>
          ))}
          {visible < queue.length && (
            <div className="py-3 text-center">
              <Button variant="outline" size="sm" onClick={() => setVisible((v) => v + PAGE_SIZE)}>Show more</Button>
            </div>
          )}
          {loaded && total > items.length && queue.length > 0 && (
            <p className="py-2 text-caption text-muted-foreground">{total - items.length} more {total - items.length === 1 ? "merchant is" : "merchants are"} waiting beyond the {items.length} shown here.</p>
          )}
          {handled.map((m) => (
            <div key={m.merchant} className="ledger-row flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantTile merchant={m.merchant} category={tileCategory(m)} />
                <div className="min-w-0">
                  <div className="truncate text-body">{m.merchant}</div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{m.detail}</div>
                </div>
              </div>
              <Chip tone={status[m.merchant] === "kept" ? "good" : "neutral"}>{status[m.merchant] === "kept" ? "Kept" : "Dismissed"}</Chip>
            </div>
          ))}
          {loaded && queue.length === 0 && total > items.length && (
            <p className="py-2 text-caption text-muted-foreground">That's all {items.length} we can show right now — {total - items.length} more {total - items.length === 1 ? "merchant is" : "merchants are"} still waiting beyond that.</p>
          )}
          {loaded && queue.length === 0 && total <= items.length && (
            <p className="py-2 text-caption text-muted-foreground">That's the queue for now — new merchants appear here when we first see them.</p>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/** Parse a £ field: "" (or whitespace) is "no limit" (null), a plain
 * number is pounds → minor units, anything else (letters, negatives)
 * is "invalid" and blocks the save with an inline error. */
function parsePounds(raw: string): number | null | "invalid" {
  const t = raw.trim().replace(/^£/, "").replace(/,/g, "").trim();
  if (t === "") return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return "invalid";
  return Math.round(v * 100);
}

const poundsInput =
  "w-24 rounded-lg border bg-card px-3 py-1.5 text-right text-body outline-none focus:ring-2 focus:ring-ring";

/**
 * Floors & budgets: the household's thresholds — an Available floor
 * (Home's Available card signals red below it), an overall monthly
 * budget (the Home hero tracks spend against it) and a monthly budget
 * per spending category (the Categories rows track against theirs).
 * All optional; an empty field is no floor / no budget. Values live
 * server-side in the store (snapshot-carried), so the form seeds from
 * the snapshot and a save PUTs the full form state, then invalidates
 * so every surface re-reads the same numbers.
 */
function FloorsBudgets() {
  const router = useRouter();
  const defs = categoryDefs();
  const settings = appSettings();
  const settingsJson = JSON.stringify(settings);
  const defsKey = defs.map((d) => d.name).join("|");

  const seedFrom = (json: string, key: string) => {
    const s = JSON.parse(json) as typeof settings;
    const asField = (minor: number | null | undefined) =>
      minor !== null && minor !== undefined ? String(minor / 100) : "";
    return {
      floor: asField(s.availableFloorMinor),
      overall: asField(s.overallMonthlyBudgetMinor),
      cats: Object.fromEntries(
        key
          .split("|")
          .filter(Boolean)
          .map((name) => [name, asField(s.categoryBudgets[name])]),
      ) as Record<string, string>,
    };
  };

  const [form, setForm] = useState(() => seedFrom(settingsJson, defsKey));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed when the snapshot's settings change under us (another
  // save, a category added) — unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setForm(seedFrom(settingsJson, defsKey));
    // seedFrom is derived from the two keys; settingsJson/defsKey are
    // the stable inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsJson, defsKey, dirty]);

  const edit = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (busy) return;
    const floorMinor = parsePounds(form.floor);
    const overallMinor = parsePounds(form.overall);
    const catPatch: Record<string, number | null> = {};
    let invalid = floorMinor === "invalid" || overallMinor === "invalid";
    for (const def of defs) {
      const parsed = parsePounds(form.cats[def.name] ?? "");
      if (parsed === "invalid") {
        invalid = true;
      } else if (parsed !== null) {
        catPatch[def.name] = parsed;
      } else if (settings.categoryBudgets[def.name] !== undefined) {
        // The field was cleared for a category that had a budget:
        // say so explicitly, or the merge would keep the old value.
        catPatch[def.name] = null;
      }
    }
    if (invalid) {
      setError("Amounts must be £0 or more — leave a field empty for no limit.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          availableFloorMinor: floorMinor,
          overallMonthlyBudgetMinor: overallMinor,
          categoryBudgets: catPatch,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? "could not save floors & budgets");
      }
      setDirty(false);
      setSaved(true);
      // Refresh the snapshot so Home and Categories judge by the new
      // numbers; a refresh failure is not a save failure.
      try {
        await router.invalidate();
      } catch {
        /* no live router in some renders */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save floors & budgets");
    }
    setBusy(false);
  };

  const amountField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden="true" className="text-muted-foreground">£</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        placeholder="No limit"
        aria-label={label}
        className={poundsInput}
      />
    </span>
  );

  return (
    <Panel className="py-2">
      <Label>Floors & budgets</Label>
      <p className="pb-1 text-caption leading-relaxed text-muted-foreground">
        Thresholds are compared against the view on screen — the household
        totals in the household view, one person's in theirs. Leave a field
        empty for no floor or budget.
      </p>
      <div className="ledger-row flex items-center justify-between gap-3 py-2.5">
        <span>Available floor</span>
        {amountField("Available floor, in pounds", form.floor, (v) =>
          edit({ floor: v }),
        )}
      </div>
      <div className="ledger-row flex items-center justify-between gap-3 py-2.5">
        <span>Overall monthly budget</span>
        {amountField("Overall monthly budget, in pounds", form.overall, (v) =>
          edit({ overall: v }),
        )}
      </div>
      {defs.map((def) => (
        <div key={def.name} className="ledger-row flex items-center justify-between gap-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <CategoryIcon category={def.name as Category} />
            <span className="truncate">{def.name}</span>
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: categoryColor(def.name) }}
            />
          </span>
          {amountField(
            `Monthly budget for ${def.name}, in pounds`,
            form.cats[def.name] ?? "",
            (v) => edit({ cats: { ...form.cats, [def.name]: v } }),
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 py-3">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        {saved && !dirty && <Chip tone="good">Saved</Chip>}
      </div>
      {error && (
        <p className="pb-2 text-caption text-destructive" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}

/**
 * Categories manager: the live category list (built-ins + customs from
 * the snapshot), add a custom category, remove an unused custom one.
 * The server refuses deletes for built-ins and for categories still in
 * use; its error is shown inline. Every change invalidates the route
 * data, so the refreshed snapshot carries the new list everywhere.
 */
function CategoriesManager() {
  const router = useRouter();
  const defs = categoryDefs();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? "could not add that category");
      }
      setName("");
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not add that category");
    }
    setBusy(false);
  };

  const remove = async (def: CategoryDef) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: def.name }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? "could not remove that category");
      }
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not remove that category");
    }
    setBusy(false);
  };

  return (
    <Panel className="py-2">
      <Label>Categories</Label>
      {defs.map((def) => (
        <div key={def.name} className="ledger-row flex items-center justify-between gap-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <CategoryIcon category={def.name as Category} />
            <span className="truncate">{def.name}</span>
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: categoryColor(def.name) }}
            />
          </span>
          {def.builtin ? (
            <Chip tone="neutral">Built-in</Chip>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => void remove(def)}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 py-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="New category name"
          aria-label="New category name"
          className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-1.5 text-body outline-none focus:ring-2 focus:ring-ring"
        />
        <Button variant="outline" size="sm" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>
      {error && (
        <p className="pb-2 text-caption text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="pb-2 text-caption text-muted-foreground">
        Custom categories join the classifier's list too — merchants similar to ones you file under a custom category will be suggested for it.
      </p>
    </Panel>
  );
}
