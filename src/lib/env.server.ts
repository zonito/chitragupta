import { readFileSync } from "node:fs";

/**
 * Load .env from the working directory into process.env, without
 * overriding variables already set. Server-only. A missing .env is
 * not an error: environment variables alone are enough.
 */
export function loadEnvFile(): void {
  try {
    for (const line of readFileSync(process.cwd() + "/.env", "utf8").split(
      "\n",
    )) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
    }
  } catch {
    // no .env — env vars only
  }
}
