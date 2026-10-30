import { createFileRoute } from "@tanstack/react-router";
import { usePerson, PageTitle, Panel, Chip, Label, meta } from "@/components/shell";
import { CARDS, MIGRATION, ownerName } from "@/lib/data";
import { AnimatedBar } from "@/components/motion";
import { AccountTile } from "@/components/tiles";

export const Route = createFileRoute("/cards")({
  head: () => meta("Cards", "Card register with a migration watch for the card being rotated."),
  component: Cards,
});

function Cards() {
  const { person } = usePerson();
  const list = CARDS.filter((c) => person === "household" || c.owner === person);
  const showWatch = person !== "nikhila";
  return (
    <div>
      <PageTitle sub="Virtual ending 4412 was frozen 2 weeks ago">Cards</PageTitle>

      {showWatch && (
        <Panel className="mb-6 bg-secondary">
          <Label>Migration watch · 4412 → 7730</Label>
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
    </div>
  );
}
