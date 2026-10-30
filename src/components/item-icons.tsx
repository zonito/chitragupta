import { Home, List, Sparkles, PieChart, Repeat, CreditCard, Upload, FileText, Calculator, Settings, ShoppingBasket, UtensilsCrossed, Bus, GraduationCap, Plane, ShoppingBag, Receipt, ArrowLeftRight, Landmark, type LucideIcon } from "lucide-react";
import { CATEGORY_COLOR, type Category } from "@/lib/data";

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  Groceries: ShoppingBasket, "Eating out": UtensilsCrossed, Transport: Bus,
  School: GraduationCap, Home, Subscriptions: Repeat, Holidays: Plane,
  Shopping: ShoppingBag, "One-off": Receipt, Transfer: ArrowLeftRight, "Moved aside": Landmark,
};
const DESTINATION: Record<string, { icon: LucideIcon; colour: string }> = {
  "/": { icon: Home, colour: "var(--primary)" },
  "/activity": { icon: List, colour: "var(--cat-transport)" },
  "/coach": { icon: Sparkles, colour: "var(--accent-ink)" },
  "/categories": { icon: PieChart, colour: "var(--cat-school)" },
  "/subscriptions": { icon: Repeat, colour: "var(--cat-subscriptions)" },
  "/cards": { icon: CreditCard, colour: "var(--cat-holidays)" },
  "/import": { icon: Upload, colour: "var(--cat-groceries)" },
  "/receipts": { icon: FileText, colour: "var(--cat-home)" },
  "/calculators": { icon: Calculator, colour: "var(--cat-shopping)" },
  "/settings": { icon: Settings, colour: "var(--cat-one-off)" },
};
function IconChip({ icon: Icon, colour }: { icon: LucideIcon; colour: string }) {
  return <span aria-hidden="true" className="item-icon" style={{ color: colour, backgroundColor: `color-mix(in oklab, ${colour} 12%, transparent)` }}><Icon size={16} strokeWidth={1.8} /></span>;
}
export function CategoryIcon({ category }: { category: Category }) {
  return <IconChip icon={CATEGORY_ICON[category]} colour={category === "Transfer" ? "var(--muted-foreground)" : category === "Moved aside" ? "var(--aside)" : CATEGORY_COLOR[category]} />;
}
export function DestinationIcon({ to }: { to: string }) {
  const item = DESTINATION[to];
  return item ? <IconChip icon={item.icon} colour={item.colour} /> : null;
}