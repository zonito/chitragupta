import type { CSSProperties } from "react";
import { ArrowLeftRight, Cloud, CreditCard, Landmark, PiggyBank, Smartphone, Tag, Users } from "lucide-react";
import { categoryColor, categoryIcon, type Category } from "@/lib/data";
import { ICON_BY_NAME } from "@/components/item-icons";

type Brand = { token: string; letter?: string; cloud?: boolean; ink?: string };
export const BRAND_TILES: Record<string, Brand> = {
  Netflix: { token: "netflix", letter: "N" },
  Spotify: { token: "spotify", letter: "S" },
  Ocado: { token: "ocado", letter: "O" },
  Amazon: { token: "amazon", letter: "a" },
  TfL: { token: "tfl", letter: "T" },
  Ikea: { token: "ikea", letter: "I" },
  "Pret A Manger": { token: "pret", letter: "P" },
  "Octopus Energy": { token: "octopus", letter: "O" },
  Jet2: { token: "jet2", letter: "J" },
  Airbnb: { token: "airbnb", letter: "A" },
  "Disney+": { token: "disney", letter: "D" },
  "The Times": { token: "times", letter: "T" },
  PureGym: { token: "puregym", letter: "P", ink: "var(--brand-puregym-foreground)" },
  "John Lewis": { token: "john-lewis", letter: "J" },
  Tesco: { token: "tesco", letter: "T" },
  Waitrose: { token: "waitrose", letter: "W" },
  Deliveroo: { token: "deliveroo", letter: "D" },
  Uber: { token: "uber", letter: "U" },
  iCloud: { token: "icloud", cloud: true },
  "Microsoft 365": { token: "microsoft", letter: "M" },
};
const ALIASES: Record<string, string> = {
  "Spotify Family": "Spotify", "Amazon Prime": "Amazon", "Tesco Express": "Tesco",
  "Jet2 Holidays · Tenerife Feb": "Jet2", "Jet2 Holidays": "Jet2",
  "Airbnb · Lisbon half-term": "Airbnb", "Airbnb Lisbon": "Airbnb",
  "iCloud+": "iCloud", "iCloud+ 2TB": "iCloud", "Microsoft 365 Family": "Microsoft 365",
  "Uber One": "Uber", "IKEA": "Ikea",
};
export function merchantBrand(merchant: string) {
  return BRAND_TILES[ALIASES[merchant] ?? merchant];
}
type TileStyle = CSSProperties & { "--tile-background"?: string; "--tile-ink"?: string };
export function MerchantTile({ merchant, category }: { merchant: string; category: Category }) {
  const brand = merchantBrand(merchant);
  const Icon = brand?.cloud
    ? Cloud
    : category === "Transfer"
      ? ArrowLeftRight
      : category === "Moved aside"
        ? Landmark
        : (ICON_BY_NAME[categoryIcon(category)] ?? Tag);
  const colour = category === "Transfer" ? "var(--muted-foreground)" : category === "Moved aside" ? "var(--aside)" : categoryColor(category);
  const style: TileStyle = { "--tile-background": brand ? `var(--brand-${brand.token})` : colour, "--tile-ink": brand?.ink ?? "var(--tile-foreground)" };
  return <span aria-hidden="true" className="recognition-tile" style={style}>{brand?.letter ?? <Icon size={19} strokeWidth={1.8} />}</span>;
}
export function accountTileKind(account: string): "virtual" | "card" | "joint" | "savings" | "bank" {
  if (/virtual/i.test(account)) return "virtual";
  if (/amex|physical|card/i.test(account)) return "card";
  if (/joint/i.test(account)) return "joint";
  if (/saving/i.test(account)) return "savings";
  return "bank";
}
export function AccountTile({ account }: { account: string }) {
  const kind = accountTileKind(account);
  const Icon = { virtual: Smartphone, card: CreditCard, joint: Users, savings: PiggyBank, bank: Landmark }[kind];
  return <span aria-hidden="true" className="recognition-tile"><Icon size={19} strokeWidth={1.8} /></span>;
}