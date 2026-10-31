import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PersonProvider, ThemeProvider } from "@/components/shell";
import {
  hydrateData,
  type AppSettings,
  type DataSnapshot,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
      <a href={to} className={className}>{children}</a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index } = await import("@/routes/index");
const { Subs } = await import("@/routes/subscriptions");
const { Settings } = await import("@/routes/settings");

/**
 * Jev integration, UI side. All fetches are stubbed: Jev's endpoints
 * are just URLs here, and each test decides what they answer. The
 * contract under test: Jev's blocks render Jev's choices verbatim
 * when an opinion exists, render NOTHING when it doesn't (or when
 * Jev is switched off — not even a fetch), and an explicit Ask Jev
 * tap is the only place an unavailability line may appear.
 */

interface Opinion {
  answers: Record<string, string>;
  at: string;
}

const net = {
  coach: null as Opinion | null,
  subCached: null as Opinion | null,
  subPost: "ok" as "ok" | "down",
  calls: [] as { url: string; method: string; body: string | undefined }[],
};

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  net.coach = null;
  net.subCached = null;
  net.subPost = "ok";
  net.calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      net.calls.push({ url: u, method, body: init?.body });
      if (u.startsWith("/api/jev/coach")) {
        return jsonRes({
          ok: true,
          jev: net.coach ? { ...net.coach, cached: true } : null,
        });
      }
      if (u.startsWith("/api/jev/subscription")) {
        if (method === "POST") {
          if (net.subPost === "down") {
            return jsonRes({ ok: false, jev: "unavailable" }, 502);
          }
          const opinion: Opinion = {
            answers: { posture: "Keep", value: "Good value" },
            at: "2026-10-30T10:00:00.000Z",
          };
          net.subCached = opinion;
          return jsonRes({ ok: true, jev: { ...opinion, cached: false } });
        }
        return jsonRes({
          ok: true,
          jev: net.subCached ? { ...net.subCached, cached: true } : null,
        });
      }
      if (u.startsWith("/api/settings")) {
        return jsonRes({ ok: true, settings: {} });
      }
      if (u.startsWith("/api/transactions")) {
        return jsonRes({ ok: true, transactions: [] });
      }
      return jsonRes({ ok: true });
    }),
  );
});

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  vi.unstubAllGlobals();
});

const withSettings = (settings: Partial<AppSettings>): DataSnapshot => ({
  ...SAMPLE_SNAPSHOT,
  settings: { ...SAMPLE_SNAPSHOT.settings, ...settings },
});

const coachCalls = () => net.calls.filter((c) => c.url.startsWith("/api/jev/coach"));

describe("Home Coach: Jev's second opinion", () => {
  it("renders Jev's two choices verbatim in a labelled block", async () => {
    net.coach = {
      answers: { posture: "Hold steady", lever: "Review subscriptions" },
      at: "2026-10-30T09:00:00.000Z",
    };
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Jev’s second opinion/)).toBeTruthy();
    });
    expect(screen.getByText("Hold steady")).toBeTruthy();
    expect(screen.getByText("Review subscriptions")).toBeTruthy();
    expect(coachCalls().length).toBe(1);
  });

  it("renders nothing when Jev has no opinion (down, nothing cached)", async () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    await waitFor(() => expect(coachCalls().length).toBe(1));
    expect(screen.queryByText(/second opinion/)).toBeNull();
  });

  it("renders nothing and never fetches when Jev is switched off", async () => {
    hydrateData(withSettings({ jevEnabled: false }));
    net.coach = {
      answers: { posture: "Hold steady", lever: "Review subscriptions" },
      at: "2026-10-30T09:00:00.000Z",
    };
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    // Give effects a chance to (not) run.
    await new Promise((r) => setTimeout(r, 50));
    expect(coachCalls().length).toBe(0);
    expect(screen.queryByText(/second opinion/)).toBeNull();
  });
});

describe("Subscription detail: Jev's opinion", () => {
  const openNetflix = async () => {
    render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Netflix transactions/ }));
    await waitFor(() => {
      expect(screen.getByText("Your correction")).toBeTruthy();
    });
  };

  it("shows the cached opinion with its date, without a live ask", async () => {
    net.subCached = {
      answers: { posture: "Watch", value: "Poor value" },
      at: "2026-10-28T09:00:00.000Z",
    };
    await openNetflix();
    await waitFor(() => {
      expect(screen.getByText(/Jev’s opinion/)).toBeTruthy();
      expect(screen.getByText("Watch")).toBeTruthy();
    });
    expect(screen.getByText("Poor value")).toBeTruthy();
    expect(screen.getByText("28 Oct 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask Jev again" })).toBeTruthy();
    // Opening the detail read the cache only: no POST happened.
    expect(
      net.calls.filter(
        (c) => c.url.startsWith("/api/jev/subscription") && c.method === "POST",
      ).length,
    ).toBe(0);
  });

  it("Ask Jev replaces the opinion; a down Jev gets one quiet line and keeps the old answer", async () => {
    await openNetflix();
    fireEvent.click(screen.getByRole("button", { name: "Ask Jev" }));
    await waitFor(() => {
      expect(screen.getByText("Keep")).toBeTruthy();
    });
    expect(screen.getByText("Good value")).toBeTruthy();

    net.subPost = "down";
    fireEvent.click(screen.getByRole("button", { name: "Ask Jev again" }));
    await waitFor(() => {
      expect(screen.getByText("Jev is unavailable right now")).toBeTruthy();
    });
    // The previous opinion is still on screen.
    expect(screen.getByText("Keep")).toBeTruthy();
  });

  it("the whole section is absent when Jev is switched off", async () => {
    hydrateData(withSettings({ jevEnabled: false }));
    await openNetflix();
    expect(screen.queryByText(/Jev’s opinion/)).toBeNull();
    expect(
      net.calls.filter((c) => c.url.startsWith("/api/jev/subscription")).length,
    ).toBe(0);
  });
});

describe("Settings: Jev section", () => {
  const renderSettings = () =>
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );

  it("status line: not called yet, answered, unavailable", () => {
    hydrateData(withSettings({ jevLastOutcome: null }));
    const { unmount } = renderSettings();
    expect(screen.getByText("Not called yet")).toBeTruthy();
    unmount();

    hydrateData(
      withSettings({
        jevLastOutcome: { status: "ok", at: "2026-10-30T08:15:00.000Z" },
      }),
    );
    const second = renderSettings();
    expect(screen.getByText(/Jev answered/)).toBeTruthy();
    second.unmount();

    hydrateData(
      withSettings({
        jevLastOutcome: { status: "unavailable", at: "2026-10-30T08:15:00.000Z" },
      }),
    );
    renderSettings();
    expect(screen.getByText(/Jev unavailable at last check/)).toBeTruthy();
  });

  it("the toggle PUTs the flipped jevEnabled", async () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: "Jev second opinions" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => {
      const put = net.calls.find(
        (c) => c.url === "/api/settings" && c.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body ?? "{}")).toEqual({ jevEnabled: false });
    });
  });
});
