import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

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
