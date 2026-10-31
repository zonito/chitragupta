import type { Person } from "./data";

/**
 * Browser-safe client for the app's Jev endpoints. Every function is
 * fail-open: any network problem, non-OK status or empty answer reads
 * as "no opinion", and the surfaces render nothing. Jev being down is
 * a normal state of the world, never an error the user should see
 * (the one exception: an explicit "Ask Jev" tap reports its own
 * quiet unavailability line, via askJevAboutSubscription's result).
 */

export interface JevOpinion {
  answers: Record<string, string>;
  at: string; // ISO time of the live call that produced the answers
}

interface JevBody {
  ok?: boolean;
  jev?: { answers?: Record<string, string>; at?: string } | null;
}

async function readOpinion(res: Response): Promise<JevOpinion | null> {
  if (!res.ok) return null;
  const body = (await res.json()) as JevBody;
  if (!body.ok || !body.jev || !body.jev.answers || !body.jev.at) return null;
  return { answers: body.jev.answers, at: body.jev.at };
}

/** Jev's coach second opinion for this view (cached server-side; the
 * server makes at most one live call a day per view). */
export async function fetchJevCoachOpinion(
  person: Person,
): Promise<JevOpinion | null> {
  try {
    const res = await fetch(`/api/jev/coach?person=${person}`);
    return await readOpinion(res);
  } catch {
    return null;
  }
}

/** The last opinion Jev gave on this subscription, if any (cache
 * only — opening the detail never triggers a live call). */
export async function fetchJevSubOpinion(
  merchant: string,
): Promise<JevOpinion | null> {
  try {
    const res = await fetch(
      `/api/jev/subscription?merchant=${encodeURIComponent(merchant)}`,
    );
    return await readOpinion(res);
  } catch {
    return null;
  }
}

export type AskJevSubResult =
  | { kind: "ok"; opinion: JevOpinion }
  | { kind: "unavailable" }
  | { kind: "error" };

/** A fresh opinion, asked for by an explicit tap. "unavailable" is
 * Jev's documented normal state (its upstream drops for stretches);
 * the caller shows one quiet line for it. */
export async function askJevAboutSubscription(
  merchant: string,
): Promise<AskJevSubResult> {
  try {
    const res = await fetch("/api/jev/subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant }),
    });
    if (res.status === 502) return { kind: "unavailable" };
    const opinion = await readOpinion(res);
    return opinion ? { kind: "ok", opinion } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}
