#!/usr/bin/env bash
# Fast test lane for pre-commit: the app's existing vitest runner with a
# hard 180s timeout. Suites that need the real data dir self-skip when
# CHITRAGUPTA_DATA_DIR is unset, which keeps this lane fast and hermetic.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if command -v timeout >/dev/null 2>&1; then
  timeout 180 pnpm test
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout 180 pnpm test
else
  # No coreutils timeout (stock macOS): perl provides the hard deadline.
  perl -e 'alarm 180; exec @ARGV' pnpm test
fi
