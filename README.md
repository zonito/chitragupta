# Chitragupta

Household expense tracker and coach for Zonito and Nikhila (London, GBP).
TanStack Start + React + Tailwind, running locally only.

## Run locally

Requires Node.js 20+ and npm.

```sh
npm install
npm run dev      # serves http://localhost:3016
```

Other commands:

```sh
npm run build    # production build → .output/ (node-server preset)
npm start        # serve the production build (node .output/server/index.mjs)
npm test         # vitest suite
npm run lint     # eslint
```

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

## Product rules (frozen)

- Household combined view is the default, with per-person views.
- Internal transfers between the couple and their own accounts/pockets are
  never income or spending.
- Money moved to savings/investments/brokers is "Moved aside", never an expense.
- No budgets, targets or limit UI anywhere; motivation is by facts only.
- Amounts are computed by code, never by an AI model.
