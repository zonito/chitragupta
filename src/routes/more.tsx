import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PageTitle, meta } from "@/components/shell";
import { DestinationIcon } from "@/components/item-icons";

export const Route = createFileRoute("/more")({
  head: () => meta("More", "Categories, subscriptions, cards, imports and settings."),
  component: More,
});

const items = [
  { to: "/categories", l: "Categories", s: "Where the month went" },
  { to: "/subscriptions", l: "Subscriptions", s: "Recurring charges" },
  { to: "/cards", l: "Cards", s: "Register & migration watch" },
  { to: "/import", l: "Import", s: "Statements per account" },
  { to: "/receipts", l: "Receipts & documents", s: "Receipts, bills and warranties" },
  { to: "/calculators", l: "Calculators", s: "Handy money maths" },
  { to: "/settings", l: "Settings", s: "People, accounts, digest" },
] as const;

function More() {
  return (
    <div className="lg:max-w-3xl">
      <PageTitle>More</PageTitle>
      <div className="rounded-xl border bg-card px-4">
        {items.map((i) => (
          <Link key={i.to} to={i.to} className="ledger-row flex items-center justify-between py-4">
            <div className="flex min-w-0 items-center gap-3"><DestinationIcon to={i.to} /><div><div>{i.l}</div><div className="text-caption text-muted-foreground">{i.s}</div></div></div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}
