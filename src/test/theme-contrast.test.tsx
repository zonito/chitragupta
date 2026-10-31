import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryChip, PersonProvider } from "@/components/shell";
import { Categories } from "@/routes/categories";
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_INK } from "@/lib/data";

/**
 * B9b / A3 §1 + §3: hover pairs and chip contrast.
 *
 * Contrast is computed from the actual token values in styles.css,
 * following the A3 method: OKLCH -> OKLab -> linear sRGB -> WCAG
 * relative luminance; tints are composited in OKLab over the card
 * surface (color-mix(in oklab, colour 12%, transparent) over --card).
 */

type Oklab = [number, number, number];

function oklch(l: number, c: number, h: number): Oklab {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}
function luminance([l, a, b]: Oklab): number {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const [l3, m3, s3] = [lp ** 3, mp ** 3, sp ** 3];
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
function contrast(fg: Oklab, bg: Oklab): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (c: Oklab, base: Oklab, w: number): Oklab =>
  c.map((v, i) => w * v + (1 - w) * (base[i] ?? 0)) as Oklab;

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
function themeBlock(selector: string): string {
  const start = css.indexOf(selector);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}
function token(block: string, name: string): Oklab {
  const m = block.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  if (!m) throw new Error(`token --${name} not found`);
  return oklch(Number(m[1]), Number(m[2]), Number(m[3]));
}
const light = themeBlock(":root {");
const dark = themeBlock(".dark {");

const CAT_TOKEN: Record<string, string> = {
  Groceries: "cat-groceries",
  "Eating out": "cat-eating-out",
  Transport: "cat-transport",
  School: "cat-school",
  Home: "cat-home",
  Subscriptions: "cat-subscriptions",
  Holidays: "cat-holidays",
  Shopping: "cat-shopping",
  "One-off": "cat-one-off",
};

describe("chip contrast (computed from styles.css tokens)", () => {
  it.each(["light", "dark"] as const)("%s: every category chip pair clears 4.5:1", (theme) => {
    const block = theme === "light" ? light : dark;
    const card = token(block, "card");
    for (const cat of CATEGORIES) {
      const base = CAT_TOKEN[cat]!;
      const colour = token(block, base);
      const ink = token(block, `${base}-ink`);
      const tint = mix(colour, card, 0.12);
      expect(contrast(ink, tint), `${theme} ${cat}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("%s: warn and good chip pairs clear 4.5:1", (theme) => {
    const block = theme === "light" ? light : dark;
    const card = token(block, "card");
    for (const name of ["warn", "good"] as const) {
      const colour = token(block, name);
      const tint = mix(colour, card, 0.15);
      expect(contrast(colour, tint), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("dark category inks equal the category colours (dark rendering unchanged)", () => {
    for (const cat of CATEGORIES) {
      const base = CAT_TOKEN[cat]!;
      expect(token(dark, `${base}-ink`)).toEqual(token(dark, base));
    }
  });
});

describe("CategoryChip rendering", () => {
  it("renders the category name, wired to the ink token for text", () => {
    // jsdom drops var()/color-mix() inline styles entirely, so the
    // rendered check is the label plus the mapping/wiring assertions.
    render(<CategoryChip category="Holidays" />);
    expect(screen.getByText("Holidays")).toBeTruthy();
    expect(CATEGORY_INK.Holidays).toBe("var(--cat-holidays-ink)");
    expect(CATEGORY_COLOR.Holidays).toBe("var(--cat-holidays)");
    const shell = readFileSync(resolve(__dirname, "../components/shell.tsx"), "utf8");
    const chipFn = shell.slice(shell.indexOf("export function CategoryChip"));
    expect(chipFn.slice(0, 800)).toContain("CATEGORY_INK[");
    expect(chipFn.slice(0, 800)).toContain("color-mix(in oklab, ${colour} 12%, transparent)");
  });
});

describe("hover pairs", () => {
  it("category rows pin hover text to the normal foreground while the background stays transparent", () => {
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    const row = screen.getByText("Groceries").closest("button")!;
    expect(row.className).toContain("hover:bg-transparent");
    expect(row.className).toContain("hover:text-foreground");
  });

  it("the error-page Go home anchor carries the intact accent pair", () => {
    const root = readFileSync(resolve(__dirname, "../routes/__root.tsx"), "utf8");
    const anchor = root.match(/<a\s+href="\/"[\s\S]*?Go home/);
    expect(anchor).toBeTruthy();
    expect(anchor![0]).toContain("hover:bg-accent");
    expect(anchor![0]).toContain("hover:text-accent-foreground");
  });
});
