import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider, usePerson } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * The rule: a filter whose value is already fixed by the global view
 * is not shown. Activity's person dropdown duplicates the global
 * person switch, so it exists only in Household view — and a leftover
 * household-era selection must never narrow (or empty) a single-
 * person list once the global view changes.
 */

function ViewSwitch() {
  const { setPerson } = usePerson();
  return (
    <>
      <button type="button" onClick={() => setPerson("household")}>
        View as Household
      </button>
      <button type="button" onClick={() => setPerson("zonito")}>
        View as Zonito
      </button>
      <button type="button" onClick={() => setPerson("nikhila")}>
        View as Nikhila
      </button>
    </>
  );
}

function renderActivity() {
  return render(
    <PersonProvider>
      <ViewSwitch />
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity person dropdown", () => {
  it("shows in Household view with the Anyone / Zonito / Nikhila / Joint options", () => {
    renderActivity();
    const select = screen.getByLabelText("Person") as HTMLSelectElement;
    expect(
      [...select.options].map((o) => [o.value, o.textContent]),
    ).toEqual([
      ["all", "Anyone"],
      ["zonito", "Zonito"],
      ["nikhila", "Nikhila"],
      ["joint", "Joint"],
    ]);
    expect(select.value).toBe("all");
  });

  it("filters the Household list, and Anyone restores it", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    const select = screen.getByLabelText("Person");

    fireEvent.change(select, { target: { value: "nikhila" } });
    expect(text()).toContain("Ocado");
    expect(text()).not.toContain("Pret A Manger");
    expect(text()).not.toContain("Enfield Council Tax");

    fireEvent.change(select, { target: { value: "joint" } });
    expect(text()).toContain("Enfield Council Tax");
    expect(text()).not.toContain("Ocado");

    fireEvent.change(select, { target: { value: "zonito" } });
    expect(text()).toContain("Pret A Manger");
    expect(text()).not.toContain("Ocado");

    fireEvent.change(select, { target: { value: "all" } });
    expect(text()).toContain("Ocado");
    expect(text()).toContain("Pret A Manger");
    expect(text()).toContain("Enfield Council Tax");
  });

  it("is hidden in a single-person view", () => {
    const { container } = renderActivity();
    fireEvent.click(screen.getByRole("button", { name: "View as Zonito" }));
    expect(screen.queryByLabelText("Person")).toBeNull();
    // The category and month filters remain.
    const selects = [...container.querySelectorAll("select")];
    expect(selects).toHaveLength(2);
    expect(
      selects.some((s) =>
        [...s.options].some((o) => o.textContent === "All categories"),
      ),
    ).toBe(true);
    expect(
      selects.some((s) => [...s.options].some((o) => o.value === "2026-10")),
    ).toBe(true);
  });

  it("a household-era Nikhila selection does not narrow the Zonito view", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    // Household era: narrow the list to Nikhila locally.
    fireEvent.change(screen.getByLabelText("Person"), {
      target: { value: "nikhila" },
    });
    expect(text()).toContain("Ocado");
    expect(text()).not.toContain("Pret A Manger");

    // The global view moves to Zonito: the dropdown goes away and the
    // lingering local selection is ignored, so Zonito's own rows (and
    // his share of joint bills) show instead of an empty list.
    fireEvent.click(screen.getByRole("button", { name: "View as Zonito" }));
    expect(screen.queryByLabelText("Person")).toBeNull();
    expect(text()).toContain("Pret A Manger");
    expect(text()).toContain("Enfield Council Tax");
    expect(text()).not.toContain("Ocado");
    expect(text()).not.toContain("Nothing here.");
  });

  it("a household-era Zonito selection does not narrow the Nikhila view", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    fireEvent.change(screen.getByLabelText("Person"), {
      target: { value: "zonito" },
    });
    expect(text()).toContain("Pret A Manger");
    expect(text()).not.toContain("Ocado");

    fireEvent.click(screen.getByRole("button", { name: "View as Nikhila" }));
    expect(screen.queryByLabelText("Person")).toBeNull();
    expect(text()).toContain("Ocado");
    expect(text()).not.toContain("Pret A Manger");
    expect(text()).not.toContain("Nothing here.");
  });

  it("returning to Household restores the dropdown and its filtering", () => {
    const { container } = renderActivity();
    const text = () => container.textContent ?? "";
    fireEvent.change(screen.getByLabelText("Person"), {
      target: { value: "nikhila" },
    });
    fireEvent.click(screen.getByRole("button", { name: "View as Zonito" }));
    expect(screen.queryByLabelText("Person")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View as Household" }));
    const select = screen.getByLabelText("Person") as HTMLSelectElement;
    expect(select.value).toBe("nikhila");
    expect(text()).toContain("Ocado");
    expect(text()).not.toContain("Pret A Manger");
  });
});
