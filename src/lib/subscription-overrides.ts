/**
 * Browser-safe client for POST /api/subscriptions/override — the one
 * write path behind every subscription correction control (the
 * Subscriptions detail actions, the "Removed by you" restore, and the
 * Activity sheet's subscription actions). The server keys the
 * override by canonical merchant; callers pass the display/store name
 * they acted on.
 */
import type { SubscriptionOverrideMode } from "./subscriptions";

export type { SubscriptionOverrideMode };

export async function postSubscriptionOverride(
  merchant: string,
  mode: SubscriptionOverrideMode | null,
): Promise<void> {
  const res = await fetch("/api/subscriptions/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchant, mode }),
  });
  if (!res.ok) throw new Error(`override request failed: ${res.status}`);
  const body = (await res.json()) as { ok?: boolean };
  if (!body.ok) throw new Error("override request failed");
}
