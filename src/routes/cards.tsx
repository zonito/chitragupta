import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePerson, PageTitle, Panel, Chip, Label, meta } from "@/components/shell";
import { CARDS, MIGRATION, ownerName, type CardItem, type Owner } from "@/lib/data";
import { AnimatedBar } from "@/components/motion";
import { AccountTile } from "@/components/tiles";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/cards")({
  head: () => meta("Cards", "Card register with a migration watch for the card being rotated."),
  component: Cards,
});

const CARDS_KEY = "chitragupta.cards.v1";
const field = "rounded-lg border bg-card px-3 py-1.5 text-body";

function Cards() {
  const { person } = usePerson();
  // Cards added in the app live in local state (restored after mount so SSR
  // matches); the register itself seeds from the snapshot and starts empty
  // until real cards are registered — statements carry no card column.
  const [added, setAdded] = useState<CardItem[]>([]);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CARDS_KEY);
      if (raw) setAdded(JSON.parse(raw) as CardItem[]);
    } catch { /* unreadable storage: start empty */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(added)); } catch { /* ignore */ }
  }, [added, restored]);

  const all = [...CARDS, ...added];
  const list = all.filter((c) => person === "household" || c.owner === person);
  const frozen = all.find((c) => c.status === "Frozen" && c.replacedBy);
  const hasMigration = MIGRATION.moved.length + MIGRATION.waiting.length > 0;
  const showWatch = person !== "nikhila" && hasMigration;

  const [label, setLabel] = useState("");
  const [type, setType] = useState<CardItem["type"]>("Virtual");
  const [last4, setLast4] = useState("");
  const [account, setAccount] = useState("");
  const [owner, setOwner] = useState<Owner>(person === "household" ? "zonito" : person);
  const addCard = () => {
    const cleanLast4 = last4.replace(/\D/g, "").slice(-4);
    if (!cleanLast4 || !account.trim()) return;
    setAdded((cards) => [
      ...cards,
      {
        label: label.trim() || "Card",
        type,
        last4: cleanLast4,
        owner,
        status: "Active",
        issued: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date()),
        account: account.trim(),
      },
    ]);
    setLabel(""); setLast4(""); setAccount("");
  };

  return (
    <div>
      <PageTitle sub={frozen ? `${frozen.type} ending ${frozen.last4} is frozen` : "Every card, in one register"}>Cards</PageTitle>

      {showWatch && (
        <Panel className="mb-6 bg-secondary">
          <Label>{frozen ? `Migration watch · ${frozen.last4} → ${frozen.replacedBy!.replace(/\D/g, "")}` : "Migration watch"}</Label>
          <div className="mt-3">
            <div className="mb-1.5 text-caption text-muted-foreground">{MIGRATION.moved.length} of {MIGRATION.moved.length + MIGRATION.waiting.length} moved</div>
            <div className="h-1.5 rounded-lg bg-muted" role="progressbar" aria-label="Cards migration" aria-valuemin={0} aria-valuemax={MIGRATION.moved.length + MIGRATION.waiting.length} aria-valuenow={MIGRATION.moved.length}>
              <AnimatedBar percent={MIGRATION.moved.length / (MIGRATION.moved.length + MIGRATION.waiting.length) * 100} className="bg-good" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-2 text-body font-medium text-good">Moved ({MIGRATION.moved.length})</div>
              {MIGRATION.moved.map((m) => (
                <div key={m.name} className="mb-2"><div className="text-body">{m.name}</div><div className="text-caption text-muted-foreground">{m.seen}</div></div>
              ))}
            </div>
            <div>
              <div className="mb-2 text-body font-medium text-warn">Not seen yet ({MIGRATION.waiting.length})</div>
              {MIGRATION.waiting.map((m) => (
                <div key={m.name} className="mb-2"><div className="text-body">{m.name}</div><div className="text-caption text-muted-foreground">{m.seen}</div></div>
              ))}
            </div>
          </div>
          <p className="mt-2 border-t border-dashed pt-3 text-body text-muted-foreground">Still needed? If not, let them lapse on the frozen card.</p>
        </Panel>
      )}

      <div className="rounded-xl border bg-card px-4">
        {list.length === 0 && (
          <p className="py-6 text-center text-body text-muted-foreground">No cards registered yet. Statements do not say which card was used, so cards are kept here by hand — add your first one below.</p>
        )}
        {list.map((c) => (
          <div key={c.last4} className="ledger-row flex items-center gap-2 py-3.5">
            <AccountTile account={c.type} />
            <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <div className="text-body">{c.type} ending <span className="num">{c.last4}</span></div>
              <Chip tone={c.status === "Active" ? "good" : c.status === "Frozen" ? "warn" : "neutral"}>{c.status}</Chip>
            </div>
            <div className="mt-1 text-caption text-muted-foreground">
              {c.account} · {ownerName(c.owner)} · issued {c.issued}
              {c.frozen && <> · {c.status === "Frozen" ? "frozen" : "retired"} {c.frozen}</>}
            </div>
            {c.replacedBy && <div className="mt-0.5 text-caption text-muted-foreground">Replaced by {c.replacedBy}</div>}
            </div>
          </div>
        ))}
      </div>

      <Panel className="mt-6">
        <Label>Add a card</Label>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Online spending" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">Type
            <select value={type} onChange={(e) => setType(e.target.value as CardItem["type"])} className={field}>
              <option>Virtual</option><option>Physical</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">Last 4 digits
            <input value={last4} onChange={(e) => setLast4(e.target.value)} inputMode="numeric" placeholder="1234" className={`${field} w-24`} />
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">Account
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Revolut Main" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">Owner
            <select value={owner} onChange={(e) => setOwner(e.target.value as Owner)} className={field}>
              <option value="zonito">Zonito</option><option value="nikhila">Nikhila</option><option value="joint">Joint</option>
            </select>
          </label>
          <Button onClick={addCard}>Add card</Button>
        </div>
      </Panel>
    </div>
  );
}
