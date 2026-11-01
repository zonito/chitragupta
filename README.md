# Chitragupta

Household expense tracker and coach for Zonito and Nikhila (London, GBP).
TanStack Start + React + Tailwind, running locally only.

## Run locally

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm dev         # serves http://localhost:3016
```

Other commands:

```sh
pnpm build       # production build → .output/ (node-server preset)
pnpm start       # serve the production build (node .output/server/index.mjs)
pnpm test        # vitest suite
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
```

## Pre-commit hooks

One step on a fresh clone, after `pnpm install`:

```sh
pre-commit install
```

That installs hygiene checks (whitespace, EOF, yaml/json/toml validity,
large-file and merge-conflict guards), Prettier, ESLint, `tsc --noEmit`,
a fast vitest lane (180s hard timeout; data-dependent suites self-skip
without `CHITRAGUPTA_DATA_DIR`), and a public-repo guard
(`scripts/hooks/block-real-data.sh`) that blocks committing
statement/data files and secret-shaped strings.
There is deliberately no commit-msg hook: this repo's history does not
follow Conventional Commits.

## Data

The app reads real data, never sample fixtures:

- `CHITRAGUPTA_DATA_DIR` — path to the synced PersonalFinance folder
  (raw Revolut exports in `Originals/`, per-person per-account month
  files under `<Person>/Revolut/<Account>/<Year>/`, receipts in
  `Documents/`). Read from `.env`; no home-directory path is hardcoded.
- `CHITRAGUPTA_STORE_DIR` — path to the local data store (SQLite file,
  schema and migrations in code). Outside the repo, never in git.

Copy `.env.example` to `.env` and fill in the paths. The store is created
on first ingest; page loads serve precomputed aggregates and never rescan
CSV files.

Optional: the app reads two alternative gateway keys. `OPENCODE_API_KEY`
(OpenCode Go) takes precedence when set: classification and Ask are
served by the Go subscription at `https://opencode.ai/zen/go/v1`,
with `OPENCODE_MODEL` defaulting to `muse-spark-1.3-contributor`.
Otherwise `MUSE_API_KEY` — a Meta Model API key (it starts with
`LLM_`) — is used. When a key is set, merchants the built-in
rules cannot classify are sent (name, transaction type and count only —
never amounts, balances or account details) to the model once each and
remembered; when unset, classification stays rules-only and unknown
merchants wait in the review queue. The same key powers Ask
(`POST /api/ask`): the app pulls the matching records, computes every
figure in code, and the model writes prose around those figures; with
no key (or on any gateway failure) Ask answers deterministically from
the same computed figures. `MUSE_API_BASE_URL` defaults to
`https://api.meta.ai` and `MUSE_MODEL` to
`muse-spark-1.3-contributor`.

## Product rules (frozen)

- Household combined view is the default, with per-person views.
- Internal transfers between the couple and their own accounts/pockets are
  never income or spending.
- Money moved to savings/investments/brokers is "Moved aside", never an expense.
- Motivation is by facts only; the only thresholds are the household's
  own optional Available floor and monthly budgets in Settings.
- Amounts are computed by code, never by an AI model.
