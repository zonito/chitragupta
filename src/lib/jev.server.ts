import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  appSettings,
  asidePace,
  availableFor,
  byCategory,
  categoryNames,
  coachLevers,
  hydrateData,
  incomeTotal,
  nextMonthName,
  shareOf,
  spendTotal,
  typicalFor,
  upcomingTotal,
  type DataSnapshot,
  type Person,
  type Sub,
} from "./data";
import { getSettings, recordJevOutcome } from "./ingest/settings";
import { getJevCache, latestJevCache, putJevCache } from "./ingest/jev-cache";
import { buildSnapshot } from "./snapshot.server";
import { canonicalMerchant } from "./subscriptions";

/**
 * Jev, integrated: a STRUCTURED second-opinion engine behind Varuna.
 *
 * Contract (verified against Varuna's OpenAPI, 31 Oct 2026):
 *   POST {VARUNA_TUNNEL_URL | http://127.0.0.1:8400}/v1/varuna/jev/ask
 *   { state: {...facts}, questions: { key: { question, choices } },
 *     model: "jev-latest" }
 *   → 200 { ok: true, data: { answers: { key: chosen string }, ... } }
 *
 * Jev only ever CHOOSES from the choices it is offered; it never sees
 * raw statement rows, per-account balances or account identifiers —
 * state payloads carry computed facts and merchant/category names
 * only. Its upstream is intermittent (multi-hour 502 stretches are
 * documented), so everything here is fail-open: answers are cached in
 * the store, surfaces render cached answers instantly, and when Jev
 * is down with nothing cached the surfaces render nothing at all.
 * Jev never triggers any action anywhere in the app.
 *
 * This module is the app's own client. The blind proxy at
 * POST /api/jev/ask (routeJev in api.ts) is a separate, Molang-facing
 * surface and stays untouched.
 */

export interface JevQuestion {
  question: string;
  choices: string[];
}

export interface JevPayload {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

export type JevAnswers = Record<string, string>;

export interface JevOpinion {
  answers: JevAnswers;
  at: string; // ISO time of the live call that produced the answers
  cached: boolean;
}

const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 20_000;

type FetchImpl = typeof fetch;

function jevTunnelUrl(): string {
  return process.env["VARUNA_TUNNEL_URL"]?.trim() || "http://127.0.0.1:8400";
}

export interface JevCallOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  now?: Date;
}

/**
 * One live Jev call. Returns the validated answers (each offered
 * question key mapped to one of its own choices — anything else is
 * dropped, and an answer set with nothing valid left is no answer),
 * or null when Jev is unreachable, errors, or replies off-contract.
 * Every live attempt records its outcome in settings for the status
 * line; cache serves never reach this function.
 */
export async function callJev(
  db: Database.Database,
  payload: JevPayload,
  opts: JevCallOptions = {},
): Promise<JevAnswers | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let answers: JevAnswers | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? JEV_TIMEOUT_MS,
    );
    try {
      const res = await fetchImpl(`${jevTunnelUrl()}/v1/varuna/jev/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          state: payload.state,
          questions: payload.questions,
          model: JEV_MODEL,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          ok?: unknown;
          data?: { answers?: unknown };
        };
        if (body.ok === true && typeof body.data?.answers === "object" && body.data.answers !== null) {
          const raw = body.data.answers as Record<string, unknown>;
          const valid: JevAnswers = {};
          for (const [key, question] of Object.entries(payload.questions)) {
            const value = raw[key];
            if (typeof value === "string" && question.choices.includes(value)) {
              valid[key] = value;
            }
          }
          if (Object.keys(valid).length > 0) answers = valid;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    answers = null;
  }
  recordJevOutcome(db, answers ? "ok" : "unavailable");
  return answers;
}

/** Cache identity: the surface, the subject (person view / canonical
 * merchant) and the exact payload asked. Same facts → same key → the
 * cached answer is the answer to the same question. */
export function jevCacheKey(
  surface: string,
  subject: string,
  payload: JevPayload,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        surface,
        subject,
        state: payload.state,
        questions: payload.questions,
      }),
    )
    .digest("hex");
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const sameUtcDay = (iso: string, now: Date): boolean =>
  iso.slice(0, 10) === now.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Coach second opinion                                                */
/* ------------------------------------------------------------------ */

/**
 * The coach payload, built from exactly the facts the deterministic
 * Coach uses (same selectors, same lever list): Available and the
 * floor gap, the last complete month's moved-aside pace, over-budget
 * and over-typical categories, the small-spends pile, next month's
 * known regulars, and the overall budget position. Returns null when
 * there is nothing to have an opinion about (no data at all, or
 * Nikhila's view before her first statements — the same guard
 * coachLines applies).
 */
export function buildCoachJevPayload(
  snap: DataSnapshot,
  person: Person,
): JevPayload | null {
  if (!snap.configured || !snap.monthKey) return null;
  hydrateData(snap);
  if (
    person === "nikhila" &&
    spendTotal("nikhila") === 0 &&
    incomeTotal("nikhila") === 0
  ) {
    return null;
  }
  const settings = appSettings();
  const available = availableFor(person).gbpTotal;
  const pace = asidePace(person);
  const spent = spendTotal(person);
  const nowByCat = new Map(
    byCategory(person).map((c) => [c.category as string, c.amount]),
  );

  const overBudget = Object.entries(settings.categoryBudgets)
    .map(([category, minor]) => ({
      category,
      over_by_gbp: round2((nowByCat.get(category) ?? 0) - minor / 100),
    }))
    .filter((x) => x.over_by_gbp > 0)
    .sort((a, b) => b.over_by_gbp - a.over_by_gbp);

  const overTypical = categoryNames()
    .map((name) => {
      const usual = typicalFor(name, person);
      const diff = (nowByCat.get(name) ?? 0) - usual;
      return { category: name, above_usual_by_gbp: round2(diff), usual };
    })
    .filter((x) => x.usual > 0 && x.above_usual_by_gbp >= 50 && x.above_usual_by_gbp >= x.usual * 0.2)
    .sort((a, b) => b.above_usual_by_gbp - a.above_usual_by_gbp)
    .slice(0, 3)
    .map(({ category, above_usual_by_gbp }) => ({ category, above_usual_by_gbp }));

  // The small-spends pile, with the same definition Coach uses.
  let smallCount = 0;
  let smallTotal = 0;
  for (const t of snap.txns) {
    if (t.monthKey !== snap.monthKey) continue;
    const share = shareOf(t, person);
    if (t.kind === "spend" && share > 0 && share < 10) {
      smallCount += 1;
      smallTotal += share;
    }
  }

  const state: Record<string, unknown> = {
    view: person,
    current_month: snap.months.find((m) => m.key === snap.monthKey)?.label ?? snap.monthKey,
    available_gbp: available === null ? null : round2(available),
    moved_aside_last_complete_month_gbp: round2(pace.total),
    moved_aside_month:
      snap.months.find((m) => m.key === pace.monthKey)?.label ?? pace.monthKey,
    spent_this_month_gbp: round2(spent),
    over_budget_categories: overBudget,
    over_typical_categories: overTypical,
    small_spends_total_gbp: round2(smallTotal),
    small_spends_count: smallCount,
    coming_up_regulars_gbp: round2(upcomingTotal(person)),
    coming_up_month: nextMonthName(),
  };
  if (settings.availableFloorMinor !== null && available !== null) {
    state["floor_gbp"] = round2(settings.availableFloorMinor / 100);
    state["floor_gap_gbp"] = round2(settings.availableFloorMinor / 100 - available);
  }
  if (settings.overallMonthlyBudgetMinor !== null) {
    state["overall_budget_gbp"] = round2(settings.overallMonthlyBudgetMinor / 100);
    state["over_overall_budget_by_gbp"] = round2(
      spent - settings.overallMonthlyBudgetMinor / 100,
    );
  }

  // Lever choices come from the actual top levers present (the same
  // ranked list Coach states), named by category, plus the two
  // standing candidates. The pace lever is a positive, not a lever to
  // pull, so it never becomes a choice.
  const leverChoices: string[] = [];
  for (const lever of coachLevers(person)) {
    const label =
      lever.kind === "small"
        ? "Small spends"
        : lever.kind === "budget" || lever.kind === "typical"
          ? lever.category
          : undefined;
    if (label && !leverChoices.includes(label)) leverChoices.push(label);
    if (leverChoices.length >= 3) break;
  }
  if (!leverChoices.includes("Review subscriptions")) {
    leverChoices.push("Review subscriptions");
  }

  return {
    state,
    questions: {
      posture: {
        question:
          "Given this household's current position, which posture fits best right now?",
        choices: ["Grow the buffer", "Hold steady", "Ease off"],
      },
      lever: {
        question: "Which single lever would help most right now?",
        choices: leverChoices.slice(0, 4),
      },
    },
  };
}

/**
 * The coach opinion for a person view: today's cached answer when the
 * facts are unchanged, one live call otherwise (at most one per day
 * per view for the same facts — the cache key is the facts), and a
 * stale cached answer rather than nothing when Jev is down. Null
 * when Jev is switched off or down with nothing cached: the Home
 * Coach card then renders exactly as it did before Jev existed.
 */
export async function coachJevOpinion(
  db: Database.Database,
  person: Person,
  opts: JevCallOptions = {},
): Promise<JevOpinion | null> {
  if (!getSettings(db).jevEnabled) return null;
  const payload = buildCoachJevPayload(buildSnapshot(), person);
  if (!payload) return null;
  const key = jevCacheKey("coach", person, payload);
  const cached = getJevCache(db, key);
  const now = opts.now ?? new Date();
  if (cached && sameUtcDay(cached.fetchedAt, now)) {
    return { answers: cached.answers, at: cached.fetchedAt, cached: true };
  }
  const answers = await callJev(db, payload, opts);
  if (answers) {
    const at = now.toISOString();
    putJevCache(db, {
      key,
      surface: "coach",
      subject: person,
      answers,
      fetchedAt: at,
    });
    return { answers, at, cached: false };
  }
  if (cached) {
    return { answers: cached.answers, at: cached.fetchedAt, cached: true };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Subscription check                                                  */
/* ------------------------------------------------------------------ */

export interface SubJevFacts {
  merchant: string;
  amount_gbp: number;
  cadence: string;
  charges: number;
  first_charge: string;
  last_charge: string;
  total_paid_gbp: number;
  category: string;
  status: string;
}

/** The subscription payload: this sub's own computed facts only —
 * what it costs, how often, how long it has run, what it has taken
 * in total, and the category its charges sit in. */
export function buildSubJevPayload(facts: SubJevFacts): JevPayload {
  return {
    state: { ...facts },
    questions: {
      posture: {
        question: "For this subscription, what is the right posture?",
        choices: ["Keep", "Watch", "Cancel candidate"],
      },
      value: {
        question: "How does the value of this subscription look?",
        choices: ["Good value", "Unclear", "Poor value"],
      },
    },
  };
}

function subFacts(db: Database.Database, sub: Sub): SubJevFacts {
  let first = "";
  let last = "";
  let totalMinor = 0;
  let category: string | null = null;
  if (sub.chargeIds.length > 0) {
    const placeholders = sub.chargeIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT effective_date, amount_minor, category FROM transactions
         WHERE fingerprint IN (${placeholders})
         ORDER BY effective_date ASC`,
      )
      .all(...sub.chargeIds) as {
      effective_date: string;
      amount_minor: number;
      category: string | null;
    }[];
    if (rows.length > 0) {
      // effective_date is a full timestamp in the store; the fact
      // Jev is offered is the charge DATE.
      first = rows[0]!.effective_date.slice(0, 10);
      last = rows[rows.length - 1]!.effective_date.slice(0, 10);
      totalMinor = rows.reduce((s, r) => s + Math.abs(r.amount_minor), 0);
      category = rows[rows.length - 1]!.category;
      // The charge rows' own count is the truth; the detector's
      // cluster count should agree, but rows win if they disagree.
      return {
        merchant: sub.name,
        amount_gbp: round2(sub.amount),
        cadence: sub.freq,
        charges: rows.length,
        first_charge: first,
        last_charge: last,
        total_paid_gbp: round2(totalMinor / 100),
        category: category ?? memoryCategory(db, sub) ?? "Subscriptions",
        status: sub.status,
      };
    }
  }
  // No charge rows readable (hand-built sub): fall back to the
  // detector's per-month cluster sums for totals and span.
  const months = sub.chargeMonths ?? [];
  return {
    merchant: sub.name,
    amount_gbp: round2(sub.amount),
    cadence: sub.freq,
    charges: sub.charges,
    first_charge: months[0]?.month ?? "",
    last_charge: months[months.length - 1]?.month ?? "",
    total_paid_gbp: round2(months.reduce((s, m) => s + m.total, 0)),
    category: memoryCategory(db, sub) ?? "Subscriptions",
    status: sub.status,
  };
}

function memoryCategory(db: Database.Database, sub: Sub): string | null {
  try {
    const row = db
      .prepare("SELECT category FROM merchant_memory WHERE merchant = ?")
      .get(canonicalMerchant(sub.name)) as { category: string } | undefined;
    return row?.category ?? null;
  } catch {
    return null;
  }
}

function findSub(snap: DataSnapshot, merchantName: string): Sub | null {
  const wanted = canonicalMerchant(merchantName);
  return snap.subs.find((s) => canonicalMerchant(s.name) === wanted) ?? null;
}

/** The last opinion Jev gave on this merchant, if any — cache only,
 * never a live call. */
export function subJevCached(
  db: Database.Database,
  merchantName: string,
): JevOpinion | null {
  const entry = latestJevCache(db, "subscription", canonicalMerchant(merchantName));
  if (!entry) return null;
  return { answers: entry.answers, at: entry.fetchedAt, cached: true };
}

export type SubJevAskResult =
  | { kind: "ok"; opinion: JevOpinion }
  | { kind: "unavailable" }
  | { kind: "not-found" }
  | { kind: "disabled" };

/**
 * A fresh subscription opinion, asked for by an explicit tap in the
 * detail view. Always a live call when Jev is enabled; the answer
 * replaces whatever was cached for this merchant. Jev's answer is
 * advice only — nothing here touches the sub or its overrides.
 */
export async function subJevAsk(
  db: Database.Database,
  merchantName: string,
  opts: JevCallOptions = {},
): Promise<SubJevAskResult> {
  if (!getSettings(db).jevEnabled) return { kind: "disabled" };
  const sub = findSub(buildSnapshot(), merchantName);
  if (!sub) return { kind: "not-found" };
  const payload = buildSubJevPayload(subFacts(db, sub));
  const answers = await callJev(db, payload, opts);
  if (!answers) return { kind: "unavailable" };
  const at = (opts.now ?? new Date()).toISOString();
  putJevCache(db, {
    key: jevCacheKey("subscription", canonicalMerchant(sub.name), payload),
    surface: "subscription",
    subject: canonicalMerchant(sub.name),
    answers,
    fetchedAt: at,
  });
  return { kind: "ok", opinion: { answers, at, cached: false } };
}
