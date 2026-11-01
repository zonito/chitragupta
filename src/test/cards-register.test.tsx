import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The Accounts section's cards link to Activity; render the router
// Link as a plain anchor (same pattern as home-available.test.tsx) so
// the screen renders without a RouterProvider.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...rest
    }: {
      to: string;
      search?: Record<string, string>;
      children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        href={`${to}?${new URLSearchParams(search ?? {}).toString()}`}
        {...rest}
      >
        {children}
      </a>
    ),
  };
});

import { Cards } from "@/routes/cards";
import { PersonProvider, usePerson } from "@/components/shell";
import { hydrateData, type CardItem } from "@/lib/data";
import { migrateStoredCards } from "@/lib/cards";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * G19: the Cards register is localStorage by design. A stored card can
 * be deleted (persisted to the same key), stored cards carry a unique
 * id so two cards sharing a last-4 do not collide as list keys, v1
 * stored entries migrate to the id shape, and the Owner select follows
 * the current person switch.
 */

const KEY = "chitragupta.cards.v1";

const v1Card = (over: Partial<CardItem>): CardItem => ({
  label: "Everyday",
  type: "Physical",
  last4: "1234",
  owner: "zonito",
  status: "Active",
  issued: "9 Jan 2025",
  account: "Revolut Main",
  ...over,
});

function renderCards(extra?: React.ReactNode) {
  return render(
    <PersonProvider>
      {extra}
      <Cards />
    </PersonProvider>,
  );
}

function PersonSwitch() {
  const { setPerson } = usePerson();
  return (
    <button type="button" onClick={() => setPerson("nikhila")}>
      Switch to Nikhila
    </button>
  );
}

function addCard(label: string, last4: string, account: string) {
  fireEvent.change(screen.getByPlaceholderText("Online spending"), {
    target: { value: label },
  });
  fireEvent.change(screen.getByPlaceholderText("1234"), {
    target: { value: last4 },
  });
  fireEvent.change(screen.getByPlaceholderText("Revolut Main"), {
    target: { value: account },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add card" }));
}

const stored = () =>
  JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown[];

beforeEach(() => {
  localStorage.clear();
  hydrateData({ ...SAMPLE_SNAPSHOT, cards: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("migrateStoredCards", () => {
  it("gives v1 entries unique ids, keeps existing ids, and drops non-cards", () => {
    const migrated = migrateStoredCards([
      v1Card({}),
      v1Card({ label: "Second" }),
      { ...v1Card({}), id: "card-keep-me" },
      { nope: true },
      "junk",
    ]);
    expect(migrated).toHaveLength(3);
    expect(new Set(migrated.map((c) => c.id)).size).toBe(3);
    expect(migrated[2]!.id).toBe("card-keep-me");
    expect(migrateStoredCards(null)).toEqual([]);
    expect(migrateStoredCards({})).toEqual([]);
  });
});

describe("Cards register (G19)", () => {
  it("deletes a card and persists the deletion to the same localStorage key", () => {
    const { unmount } = renderCards();
    addCard("Everyday", "1234", "Revolut Main");
    expect(screen.getByText(/Virtual ending/)).toBeTruthy();
    expect(stored()).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Everyday ending 1234" }),
    );
    expect(screen.queryByText(/Virtual ending/)).toBeNull();
    expect(stored()).toEqual([]);

    unmount();
    renderCards();
    expect(screen.queryByText(/Virtual ending/)).toBeNull();
    expect(screen.getByText(/No cards registered yet/)).toBeTruthy();
  });

  it("keys two cards sharing a last-4 uniquely and deletes only the chosen one", () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    renderCards();
    addCard("First", "1234", "Revolut Main");
    addCard("Second", "1234", "Monzo Current");
    expect(screen.getAllByText(/ending/)).toHaveLength(2);
    expect(stored()).toHaveLength(2);
    const ids = (stored() as { id: string }[]).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(errors.flat().join(" ")).not.toMatch(/same key|duplicate key/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete First ending 1234" }),
    );
    expect(
      screen.getByRole("button", { name: "Delete Second ending 1234" }),
    ).toBeTruthy();
    expect(stored()).toHaveLength(1);
    expect((stored()[0] as { label: string }).label).toBe("Second");
  });

  it("migrates a v1 stored register on restore and persists the id shape", () => {
    localStorage.setItem(KEY, JSON.stringify([v1Card({})]));
    renderCards();
    expect(screen.getByText(/Physical ending/)).toBeTruthy();
    const after = stored() as { id?: string }[];
    expect(after).toHaveLength(1);
    expect(typeof after[0]!.id).toBe("string");
    expect(after[0]!.id).toBeTruthy();
    // The migrated card is deletable like any stored card.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Everyday ending 1234" }),
    );
    expect(stored()).toEqual([]);
  });

  it("moves the Owner select when the person switch changes", () => {
    renderCards(<PersonSwitch />);
    const owner = screen.getByLabelText(/Owner/) as HTMLSelectElement;
    // Household view defaults the form to Zonito.
    expect(owner.value).toBe("zonito");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Nikhila" }));
    expect(owner.value).toBe("nikhila");
  });
});
