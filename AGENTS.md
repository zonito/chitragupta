# AGENTS.md — Chitragupta

Single instruction file for any agent working in this repo. If a sibling
instruction file exists, it only points here; nothing here is duplicated
elsewhere. Verify claims against the code before repeating them.

## 1. What this app is

Chitragupta is a local-only household expense tracker and coach for two
people (London, GBP) plus the data APIs behind it. It ingests bank/card
statement exports, classifies merchants, and serves per-person and
household views, forecasts, calculators and an Ask feature. The same
server also exposes a digest-data API (`GET /api/digest`) and document,
receipt and contribution endpoints consumed outside the UI. Detail that
belongs to humans lives in [README.md](README.md); this file only holds
agent-facing rules.

## 2. Run, build, test, restart

Package manager is pnpm (see `package.json` scripts; lockfile
`pnpm-lock.yaml`). Node 20+.

- Install: `pnpm install`
- Dev server: `pnpm dev` → `vite dev --port 3016 --strictPort`,
  serves <http://localhost:3016>
- Production build: `pnpm build` → `.output/` (Nitro `node-server`)
- Serve production build: `pnpm start` (`node .output/server/index.mjs`)
- Tests: `pnpm test` (`NODE_ENV=test vitest run`)
- Lint / types: `pnpm lint` (eslint), `pnpm typecheck` (`tsc --noEmit`)
- Format: `pnpm format` (prettier)

The always-on local instance is the launchd service
`com.zonito.chitragupta.dev` (`~/Library/LaunchAgents/com.zonito.chitragupta.dev.plist`,
outside the repo), which runs the dev server on port 3016 from this
working directory with KeepAlive. Restart it after a change with
`launchctl kickstart -k gui/$(id -u)/com.zonito.chitragupta.dev`, then
verify the app is actually up on the new code — a process existing is
not proof:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3016/
curl -s http://localhost:3016/api/digest | head -c 200
```

## 3. Architecture map

- Entry: `src/server.ts` (SSR error wrapper, routes API calls to
  `handleChitraguptaApi`) → `src/router.tsx`, `src/routes/__root.tsx`.
- Pages: file routes in `src/routes/` (`index`, `activity`, `cards`,
  `categories`, `coach`, `calculators`, `import`, `receipts`,
  `settings`, `subscriptions`, `more`).
- HTTP API: `src/lib/api.ts` — every `/api/*` handler lives here.
- UI snapshot: `getSnapshot` server function in `src/lib/snapshot.ts`,
  built by `buildSnapshot()` in `src/lib/snapshot.server.ts` from the
  SQLite store. It has a build-generated RPC URL, not a stable path.
- Money and decision logic:
  - `src/lib/ingest/` — statement parsing (`parse.ts`), ingest and
    aggregate recomputation (`ingest.ts`, `recomputeAggregates`),
    merchant memory and classification (`merchants.ts`, `classify.ts`),
    the SQLite store and schema (`store.ts`), settings, categories.
  - `src/lib/forecast.ts` — month forecast, regulars, pace.
  - `src/lib/calculators.ts` — calculator arithmetic and saved-state
    validation (browser-safe, unit-tested without rendering).
  - `src/lib/ask.server.ts` / `src/lib/ask-query.ts` — Ask: records are
    pulled and every figure computed in code; the model only writes
    prose around computed figures.
  - `src/lib/data.ts` — snapshot types and pure derivations shared by
    UI and API.
- Data flow in: statement files under `CHITRAGUPTA_DATA_DIR` (raw
  exports in `Originals/`, per-person/per-account month files,
  receipts and documents under `Documents/`) → ingest → SQLite store in
  `CHITRAGUPTA_STORE_DIR` (`chitragupta.sqlite`, outside the repo) →
  precomputed `month_aggregates` + snapshot → UI and `/api/*`.
- Data flow out: the UI, `GET /api/digest`, and the other `/api/*`
  endpoints documented in `openapi.yaml`.

## 4. Behaviour contracts and invariants

- **Public repo.** Examples and fixtures are synthetic only. The
  commit-time guard `scripts/hooks/block-real-data.sh` blocks data
  files (`.csv`/`.ofx`/`.qif`/`.sqlite`/`.db` outside `fixtures/`),
  `Documents/` and `Originals/` paths, env files other than
  `.env.example`, secret-shaped strings, and real account identifiers.
- Real account identifiers (full savings account numbers, sort codes,
  8-digit numbers in account context) never land in code, comments,
  fixtures or docs. Real identifiers live only in
  `account-identifiers.json` in the data dir (outside the repo); tests
  use the synthetic `Savings-9000…` range.
- **Totals are per-currency and never summed across currencies.**
  `/api/digest` `byMonth` is per-person by contract — the stored
  household rows are the sum of the people, so including them would
  double totals for any consumer adding the people up.
- **Ingestion is incremental with precomputed aggregates.** Rows are
  deduplicated by fingerprint (`INSERT OR IGNORE` in `ingest.ts`);
  page loads serve `month_aggregates` and never rescan CSV files.
  Bumping ingest classification rules requires bumping `RULES_VERSION`
  in `src/lib/ingest/store.ts` so old derived rows are rebuilt, never
  kept stale.
- **The digest-data API is an external contract.** Any change to
  `/api/digest` (or any endpoint: path, method, parameters, request or
  response shape, status codes, auth) is a breaking change for
  downstream consumers and must update `openapi.yaml` and
  `postman_collection.json` in the same change (see §9).
- Product rules (frozen, from README): household combined view is the
  default with per-person views; internal transfers between the couple
  and their own accounts/pockets are never income or spending; money
  moved to savings/investments/brokers is "Moved aside", never an
  expense; motivation is by facts only — the only thresholds are the
  household's own optional Available floor and monthly budgets.
- No auth on any endpoint today (local-only household app). Never
  document auth the code does not enforce, and never document an
  endpoint that does not exist.

## 5. Accuracy

- Money is integer minor units end to end: `amount_minor`,
  `spend_minor`, `income_minor`, `aside_minor` in the store;
  `Math.round(pounds * 100)` at parse time (`src/lib/ingest/parse.ts`).
  Convert to major units only at display (`minor / 100`).
- Missing money is `null`, never a fabricated zero: a run that recorded
  no balance leaves the balance unknown (`null`), and surfaces must
  render that as unknown, not £0.
- Figures are never invented or hardcoded into displays, and never
  computed by an AI model. Classification and Ask send only merchant
  name, transaction type and count to the model — never amounts,
  balances or account details; Ask figures are computed in code first.
- Verify a number by recomputing one case by hand from the store rows
  (or the source statement) and cross-checking against the upstream
  source. Test fixtures use synthetic data only; data-dependent suites
  self-skip without `CHITRAGUPTA_DATA_DIR`.

## 6. Freshness

- "Fresh" here means: the snapshot and API reflect the latest completed
  ingest run in the store. There is no snapshot TTL or HTTP cache to
  tune; staleness enters only through ingest, so re-importing is what
  makes data fresh.
- Per-account staleness is explicit: an account is `stale` when its
  latest statement-bearing run is more than 7 days older than the
  newest run of any account (`src/lib/snapshot.server.ts`). A no-op
  re-import (`rows_seen = 0`) or a failed run must never pose as an
  upload or reset that clock.
- Balances speak as of their own date: a statement balance as of its
  run's statement date, a derived (anchor-walked) balance as of
  `balanceAsOf`. Never present either as today's balance.
- Jev (second-opinion) answers are cached in the store per UTC day per
  facts-key and served stale rather than not at all when the gateway is
  down (`src/lib/jev.server.ts`); surfaces label cached answers via
  the `cached` flag. Classification results are remembered per merchant
  in `merchant_memory`, so a merchant is classified once, not per load.

## 7. Performance

- Page loads serve the snapshot and precomputed aggregates; the request
  path must never rescan statement CSVs or recompute aggregates per
  request. Ingest and `recomputeAggregates` are the only heavy writers
  and run on import, not on read.
- API list endpoints are bounded: `/api/digest` caps its lists
  (`LIMIT 200` week transactions, `LIMIT 50` one-offs, `LIMIT 20`
  regulars/merchants) and `/api/transactions` caps `limit` (default
  200, max 1000, or 10000 for month ranges). Filters are applied in SQL
  before `LIMIT`, never as a JS post-filter over a limited page.
- Do not add per-row upstream calls or unbounded fan-outs: classification
  batches unknown merchants once each, Ask pulls matching records in
  bulk and computes figures in code, and Jev answers are cached (§6)
  instead of re-fetched per render.

## 8. Quality gates

Pre-commit (`.pre-commit-config.yaml`; install once with
`pre-commit install` after `pnpm install`):

- Hygiene: trailing whitespace, EOF, yaml/json/toml validity, 500 KB
  large-file guard, merge-conflict and private-key detection.
- `prettier --write`, `eslint`, `tsc --noEmit`.
- Fast tests: `bash scripts/hooks/fast-test.sh` — `pnpm test` under a
  hard 180 s timeout; data-dependent suites self-skip without
  `CHITRAGUPTA_DATA_DIR`.
- Public-repo guard: `scripts/hooks/block-real-data.sh` (§4).
- API docs: `python3 scripts/check-api-docs.py` on commits touching
  `openapi.yaml`, `postman_collection.json`, `src/lib/api.ts`,
  `src/lib/snapshot.ts` or `src/routes/` (see §9).

There is deliberately no commit-msg hook; history does not follow
Conventional Commits. Green means: the full `pnpm test`, `pnpm lint`
and `pnpm typecheck` pass, not just the lanes a hook happened to run.

Standing completeness expectations for any change: proofread the diff,
run the full suite, push to origin, restart the service (§2), and
verify live on the new code. A local-only commit is not done.

## 9. API documentation

- `openapi.yaml` (repo root) is the OpenAPI 3.0 contract of record for
  every HTTP endpoint this app serves, and `postman_collection.json`
  is its Postman Collection v2.1 companion: one request per spec
  operation, folders matching the spec's tags, collection variable
  `{{baseUrl}}` defaulting to `http://100.125.239.56:3016`.
- Any change that adds, removes or alters an endpoint must update both
  files in the SAME change. This covers the JSON APIs in
  `src/lib/api.ts`, the file-based page routes under `src/routes/`,
  and any new server function or proxy route.
- The snapshot server function `getSnapshot` (`src/lib/snapshot.ts`)
  has a build-generated RPC URL, not a stable path; it is inventoried
  in the spec's `info.description` rather than as a path. If it (or any
  endpoint) ever gains a stable path, add it to the spec and collection
  in the same change.
- Examples in both files use obviously synthetic values only (fictional
  merchants, round placeholder amounts). Per-currency amounts in
  examples stay per-currency; totals are never summed across currencies.
- Validate before committing (all three must pass):
  - Spec: `python3 -m openapi_spec_validator openapi.yaml` (expects
    `openapi.yaml: OK`; install with `pip install openapi-spec-validator pyyaml`).
  - Coverage diff + collection: `python3 scripts/check-api-docs.py` —
    re-derives the route inventory from `src/lib/api.ts` and
    `src/routes/`, diffs it against the spec in both directions (must
    be zero), validates the spec, and checks the collection is v2.1
    and matches the spec's paths and methods one for one.
  - Collection JSON sanity: `python3 -m json.tool postman_collection.json > /dev/null`.
- If a generator is later introduced to produce the spec (or the
  collection) from code, update this section in the same change to name
  the generator command instead of the hand-editing steps; the coverage
  gate above stays.

## 10. Carefulness

- Secrets live in environment or local files only (`.env`, gitignored;
  `.env.example` is the only committable env file) — never committed,
  never printed. Keys: `OPENCODE_API_KEY` (takes precedence) or
  `MUSE_API_KEY`; data paths: `CHITRAGUPTA_DATA_DIR`,
  `CHITRAGUPTA_STORE_DIR` — no home-directory path is hardcoded.
- Never hand-edit generated or data files: `src/routeTree.gen.ts`
  (TanStack router), `.output/` (build), `pnpm-lock.yaml` (pnpm), the
  SQLite store and anything under the data/store dirs (ingest), and
  `openapi.yaml`/`postman_collection.json` only together with the route
  change that alters the contract (§9).
- Real data files (statements, exports, the store, `Documents/`,
  `Originals/`) never enter git — the guard in §4 blocks them; do not
  bypass it (`--no-verify`, force-adding) to land one.
- Destructive or outward-facing operations (deleting store or data-dir
  content, rewriting git history, changing the launchd service, any
  push or publish beyond the standing push-to-origin expectation in
  §8) need the owner's explicit go-ahead first.

## 11. UI conventions (kept from the previous AGENTS.md)

- Keep calculator arithmetic and saved-state validation in
  `src/lib/calculators.ts`, separate from the route, so calculations
  are directly testable without rendering. Restore calculator
  localStorage values only after mount and save only after restoration,
  so SSR matches and saved inputs are not overwritten.
- Theme controls and calculator panels through global semantic tokens;
  the `.dark` token overrides keep the shell and screens consistent.
  Theme choice (system/light/dark) lives in `ThemeProvider` in
  `src/components/shell.tsx` with a pre-paint head script; desktop
  (lg+) swaps header/tabs for a sidebar in `AppShell` — keep mobile
  classes unprefixed and desktop changes behind `lg:`.
- Document state lives in a root-mounted `DocumentsProvider` synced
  from the snapshot's persisted documents (files under the data dir's
  `Documents` tree, recorded in the store) so Activity attachments and
  Receipts remain synchronized across navigation; detaching retains the
  file as unmatched.
- Logo geometry lives in the reusable `Logo` component
  (`src/components/logo.tsx`) and matching public SVG favicon; keep
  their paths synchronized so the app and browser icon share one
  identity.
- Spending-category colours resolve through `CATEGORY_COLOR` to global
  theme tokens; `CategoryChip` and inherited Sparkline colour keep
  repeated data visualizations consistent.
- Shared item-icons (`src/components/item-icons.tsx`) map categories
  and destinations to semantic palette tokens and informative glyphs;
  identity surfaces, shadows and serif eligibility are governed
  globally so routes preserve their data and structure.
- Shared motion primitives (`src/components/motion.tsx`) own mounted
  data-bar transitions and first-view numeric counts; text stays
  stationary without entrance animations, and one global
  reduced-motion guard keeps final states instant.
- Global semantic type tokens define the UI scale and tabular money
  inheritance; explicit `num` classes mark money containers, and only
  `brand-wordmark` and `hero-number` may render the display family.
- Shared recognition tiles (`src/components/tiles.tsx`) resolve
  explicit merchant aliases to brand tokens and otherwise reuse
  `CATEGORY_ICON`; neutral account tiles classify account/card names
  centrally so recognition stays consistent across screens.
- Ask record search stays in a browser-safe library
  (`src/lib/record-search.ts`) and reads live shared documents plus
  recorded transaction metadata; do not invent missing events or
  duplicate a linked payment and file.

## 12. Keeping this file true

AGENTS.md is updated in the same change whenever commands, architecture,
contracts, ports or data flows change. Stale guidance is deleted, never
left standing next to its replacement. Every command, path, port and
behaviour claim in this file was checked against the code at the time
of writing; re-check before trusting any of it after a large change.
