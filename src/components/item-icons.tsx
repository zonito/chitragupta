import {
  Home,
  List,
  Sparkles,
  PieChart,
  Repeat,
  CreditCard,
  Upload,
  FileText,
  Calculator,
  Settings,
  ShoppingBasket,
  UtensilsCrossed,
  Bus,
  GraduationCap,
  Plane,
  ShoppingBag,
  Receipt,
  ArrowLeftRight,
  Landmark,
  Tag,
  Star,
  Heart,
  BookOpen,
  Music,
  Dumbbell,
  PawPrint,
  Gift,
  Wrench,
  Leaf,
  Wallet,
  Baby,
  Car,
  Coffee,
  type LucideIcon,
} from "lucide-react";
import { categoryColor, categoryIcon, type Category } from "@/lib/data";

/** Icon name → glyph. Category defs (built-in and custom) carry one of
 * these names; an unknown name falls back to the tag. */
export const ICON_BY_NAME: Record<string, LucideIcon> = {
  "shopping-basket": ShoppingBasket,
  "utensils-crossed": UtensilsCrossed,
  bus: Bus,
  "graduation-cap": GraduationCap,
  home: Home,
  repeat: Repeat,
  plane: Plane,
  "shopping-bag": ShoppingBag,
  receipt: Receipt,
  tag: Tag,
  star: Star,
  heart: Heart,
  "book-open": BookOpen,
  music: Music,
  dumbbell: Dumbbell,
  "paw-print": PawPrint,
  gift: Gift,
  wrench: Wrench,
  leaf: Leaf,
  wallet: Wallet,
  sparkles: Sparkles,
  baby: Baby,
  car: Car,
  coffee: Coffee,
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
function IconChip({
  icon: Icon,
  colour,
}: {
  icon: LucideIcon;
  colour: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="item-icon"
      style={{
        color: colour,
        backgroundColor: `color-mix(in oklab, ${colour} 12%, transparent)`,
      }}
    >
      <Icon size={16} strokeWidth={1.8} />
    </span>
  );
}
export function CategoryIcon({ category }: { category: Category }) {
  if (category === "Transfer") {
    return <IconChip icon={ArrowLeftRight} colour="var(--muted-foreground)" />;
  }
  if (category === "Moved aside") {
    return <IconChip icon={Landmark} colour="var(--aside)" />;
  }
  const Icon = ICON_BY_NAME[categoryIcon(category)] ?? Tag;
  return <IconChip icon={Icon} colour={categoryColor(category)} />;
}
export function DestinationIcon({ to }: { to: string }) {
  const item = DESTINATION[to];
  return item ? <IconChip icon={item.icon} colour={item.colour} /> : null;
}
