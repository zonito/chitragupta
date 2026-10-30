import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageTitle, Panel, Label, Chip, Row, Sheet, meta, useTheme, type ThemeChoice } from "@/components/shell";
import { ACCOUNTS, MERCHANT_REVIEW } from "@/lib/data";
import { AccountTile, MerchantTile } from "@/components/tiles";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/settings")({
  head: () => meta("Settings", "People, accounts, currency and digest preferences."),
  component: Settings,
});

function Settings() {
  const { theme, setTheme } = useTheme();
  const accs = (o: string) => ACCOUNTS.filter((a) => a.owner === o);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [status, setStatus] = useState<Record<string, "kept" | "dismissed">>({});
  const queue = MERCHANT_REVIEW.filter((m) => !status[m.name]);
  const handled = MERCHANT_REVIEW.filter((m) => status[m.name]);
  const review = (name: string, verdict: "kept" | "dismissed") => setStatus((s) => ({ ...s, [name]: verdict }));
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
          right={<Chip tone="neutral">{queue.length === 0 ? "Review queue is clear" : `${queue.length} ${queue.length === 1 ? "merchant" : "merchants"} waiting for review`}</Chip>}
        />
      </Panel>
      <p className="px-1 text-caption leading-relaxed text-muted-foreground">
        Your data stays with you. Transfers between Zonito and Nikhila are never counted as spending, and money moved to savings or investments shows separately as "Moved aside".
      </p>
      <p className="px-1 text-caption text-muted-foreground">Statements live in Drive; aggregates are precomputed.</p>

      <Sheet open={reviewOpen} onClose={() => setReviewOpen(false)}>
        <h2 className="mb-1 text-heading font-semibold">Merchant review</h2>
        <p className="mb-4 text-caption leading-relaxed text-muted-foreground">Merchants we haven't seen before. Keeping confirms the category; dismissing marks it as noise.</p>
        <div>
          {queue.map((m) => (
            <div key={m.name} className="ledger-row flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantTile merchant={m.name} category={m.category} />
                <div className="min-w-0">
                  <div className="truncate text-body">{m.name}</div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{m.detail}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => review(m.name, "kept")}>Keep</Button>
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => review(m.name, "dismissed")}>Dismiss</Button>
              </div>
            </div>
          ))}
          {handled.map((m) => (
            <div key={m.name} className="ledger-row flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantTile merchant={m.name} category={m.category} />
                <div className="min-w-0">
                  <div className="truncate text-body">{m.name}</div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{m.detail}</div>
                </div>
              </div>
              <Chip tone={status[m.name] === "kept" ? "good" : "neutral"}>{status[m.name] === "kept" ? "Kept" : "Dismissed"}</Chip>
            </div>
          ))}
          {handled.length === MERCHANT_REVIEW.length && (
            <p className="py-2 text-caption text-muted-foreground">That's the queue for now — new merchants appear here when we first see them.</p>
          )}
        </div>
      </Sheet>
    </div>
  );
}
