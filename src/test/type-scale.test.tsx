import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonProvider, ThemeProvider } from "@/components/shell";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import { Settings } from "@/routes/settings";
import { Subs } from "@/routes/subscriptions";

/**
 * B9b / A3 §2: content-bearing text sits at the body token (15px).
 * Shell spots (PersonSwitch, sidebar nav, Ask ledger rows) are pinned
 * on their class strings; route spots are rendered. Genuine labels,
 * chips and fragments stay at caption/micro — pinned where they share
 * a container with promoted text.
 */

const shell = readFileSync(resolve(__dirname, "../components/shell.tsx"), "utf8");

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("shell type scale (class pins)", () => {
  it("PersonSwitch and sidebar nav labels are text-body, not text-sm", () => {
    expect(shell).toContain("flex rounded-full bg-muted p-1 text-body");
    expect(shell).toContain("rounded-xl px-3 py-2 text-body transition");
    expect(shell).not.toContain("rounded-xl px-3 py-2 text-sm");
  });

  it("all four Ask ledger row shapes are text-body, not text-sm", () => {
    const rows = shell.match(/ledger-row flex justify-between gap-3 py-2 text-(sm|body)/g) ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.endsWith("text-body"))).toBe(true);
  });
});

describe("route type scale (rendered)", () => {
  it("Settings explainer paragraphs render at text-body", () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    const privacy = screen.getByText(/Your data stays with you/);
    expect(privacy.className).toContain("text-body");
    expect(privacy.className).not.toContain("text-caption");
    const storage = screen.getByText(/Statements live in Drive/);
    expect(storage.className).toContain("text-body");
  });

  it("the subscription note renders at text-body while its meta fragments stay caption", () => {
    const { container } = render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    // Netflix in the sample snapshot carries this note.
    const note = screen.getByText("£17.99 → £18.99 · Moved to the new card");
    expect(note.className).toContain("text-body");
    const meta = [...container.querySelectorAll("div")].find((d) =>
      /^Monthly · .* a year$/.test(d.textContent ?? ""),
    );
    expect(meta).toBeTruthy();
    expect(meta!.className).toContain("text-caption");
  });

  it("the Calculators per-wear sentence is text-body in source (route needs no data)", () => {
    const calc = readFileSync(resolve(__dirname, "../routes/calculators.tsx"), "utf8");
    const line = calc.split("\n").find((l) => l.includes("boots worn"));
    expect(line).toContain("text-body");
    expect(line).not.toContain("text-caption");
    // The illustration caveat is a genuine caveat and stays caption.
    const caveat = calc.split("\n").find((l) => l.includes("Interest compounded monthly"));
    expect(caveat).toContain("text-caption");
  });
});
