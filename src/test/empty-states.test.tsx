import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { EMPTY_SNAPSHOT, hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    // Link needs a RouterProvider in real rendering; in these component
    // tests a plain anchor carries the same href and label.
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index } = await import("@/routes/index");
const { Import } = await import("@/routes/import");

/**
 * B9b / A3 §4.5: honest empty states. Home with no data renders one
 * empty state instead of £0 panels and dangling month captions;
 * Import with no accounts explains the empty box. Populated rendering
 * is pinned unchanged.
 */

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, accounts: [] }),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Home empty state", () => {
  it("renders one empty state with no data, and no dangling captions or £0 panels", () => {
    hydrateData(EMPTY_SNAPSHOT);
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText("No statements imported yet")).toBeTruthy();
    expect(screen.getByText(/Head to/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Import" }).getAttribute("href"),
    ).toBe("/import");
    expect(container.textContent).not.toContain("Spent in");
    expect(container.textContent).not.toContain("Coming up");
    expect(container.textContent).not.toContain("Biggest changes");
    expect(container.textContent).not.toContain("Money in");
    expect(container.textContent).not.toContain("£0");
  });

  it("also treats a snapshot with a month but zero transactions as empty", () => {
    hydrateData({ ...SAMPLE_SNAPSHOT, txns: [] });
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText("No statements imported yet")).toBeTruthy();
  });

  it("populated rendering is unchanged", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText("Spent in October")).toBeTruthy();
    expect(screen.getByText("Biggest changes")).toBeTruthy();
    expect(screen.getByText("Money in · October")).toBeTruthy();
    expect(screen.getByText("Coming up · November")).toBeTruthy();
    expect(screen.queryByText("No statements imported yet")).toBeNull();
  });
});

describe("Import empty state", () => {
  it("explains the empty account list instead of a bare box", () => {
    hydrateData(EMPTY_SNAPSHOT);
    render(
      <PersonProvider>
        <Import />
      </PersonProvider>,
    );
    expect(
      screen.getByText(
        /No accounts yet — accounts appear here once statements have been imported/,
      ),
    ).toBeTruthy();
  });

  it("populated account list renders as before with no empty line", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    render(
      <PersonProvider>
        <Import />
      </PersonProvider>,
    );
    expect(screen.getByText("Revolut Main")).toBeTruthy();
    expect(screen.queryByText(/No accounts yet/)).toBeNull();
  });
});
