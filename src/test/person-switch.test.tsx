import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { personLabel } from "@/lib/data";

/**
 * The person switch is a segmented pill of three EQUAL segments: each
 * button flexes to a third of the control, so the selected pill is
 * always the same size as the others, and the combined view is
 * labelled "All" (the long "Household" label made its pill look
 * stretched). Segment labels render through the shared personLabel
 * helper (emoji + text). jsdom has no layout engine, so — like the
 * type-scale and sheet pins — the layout contract is pinned on the
 * class strings the switch renders with. Prose that says Household
 * (e.g. the Ask "Household answer" label) is not this control and
 * stays.
 */

const shell = readFileSync(
  resolve(__dirname, "../components/shell.tsx"),
  "utf8",
);
const optsBlock = shell.slice(
  shell.indexOf("const OPTS"),
  shell.indexOf("];", shell.indexOf("const OPTS")),
);
const switchBody = shell.slice(
  shell.indexOf("function PersonSwitch"),
  shell.indexOf("const SIDE"),
);

describe("PersonSwitch", () => {
  it("labels the combined segment All, not Household", () => {
    expect(optsBlock).toContain('{ v: "household" }');
    expect(optsBlock).not.toContain("Household");
    expect(optsBlock).toContain('{ v: "zonito" }');
    expect(optsBlock).toContain('{ v: "nikhila" }');
    expect(switchBody).toContain("personLabel(o.v)");
  });

  it("personLabel carries the shared emoji + text for every person and owner", () => {
    expect(personLabel("household")).toBe("🏠 All");
    expect(personLabel("zonito")).toBe("👨 Zonito");
    expect(personLabel("nikhila")).toBe("👩 Nikhila");
    expect(personLabel("joint")).toBe("🤝 Joint");
  });

  it("gives every segment an equal third of the control", () => {
    expect(switchBody).toContain(
      'className="flex rounded-full bg-muted p-1 text-body"',
    );
    expect(switchBody).not.toContain("grid-cols-3");
    expect(switchBody).toContain("flex-1 rounded-full py-1.5 text-center");
  });

  it("keeps the selected-state styling and tap padding unchanged", () => {
    expect(switchBody).toContain(
      'person === o.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"',
    );
    expect(switchBody).toContain("py-1.5");
  });

  it("leaves Household prose outside the switch alone", () => {
    expect(shell).toContain("<Label>Household answer</Label>");
  });
});
