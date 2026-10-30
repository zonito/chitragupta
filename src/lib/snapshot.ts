import { createServerFn } from "@tanstack/react-start";
import type { DataSnapshot } from "./data";

/**
 * Fetches the UI snapshot from the server store. The builder (better-sqlite3)
 * is imported dynamically inside the handler so it never reaches the client
 * bundle. With no store configured this returns the honest empty snapshot.
 */
export const getSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<DataSnapshot> => {
    const { buildSnapshot } = await import("./snapshot.server");
    return buildSnapshot();
  },
);
