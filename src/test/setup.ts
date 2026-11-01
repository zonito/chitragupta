import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

// Deterministic test clock: the suites were written against the
// fixtures' October-2026 anchor, and the display-month rule reads
// "today" (Europe/London) through calendar.server, which honours
// CHITRAGUPTA_TODAY. Pin it here so a plain `npm test` run is
// date-independent; a caller-provided pin wins, and tests that pin
// their own date (display-month.test.tsx) override it locally and
// restore this value afterwards.
process.env["CHITRAGUPTA_TODAY"] ??= "2026-10-30";

// UI data helpers run over a hydrated snapshot; tests get the known sample
// month. Production data arrives the same way, built from the real store.
hydrateData(SAMPLE_SNAPSHOT);

// Persisted preferences (theme, chart state, card register) live in
// localStorage: no test may inherit another test's stored state.
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable in this environment */
  }
});

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
