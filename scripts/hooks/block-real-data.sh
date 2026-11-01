#!/usr/bin/env bash
# Public-repo guard: block real financial data and secrets from landing.
# Receives candidate file paths from pre-commit (staged files, or every
# tracked file under --all-files). Exit 1 blocks the commit.
set -u
fail=0

for f in "$@"; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  case "$f" in
    # Synthetic CSV fixtures under a fixtures/ tree are the one allowed CSV.
    */fixtures/*) ;;
    *.csv|*.ofx|*.qif|*.sqlite|*.sqlite-*|*.db)
      echo "block-real-data: data file must not be committed: $f" >&2; fail=1 ;;
  esac
  case "$base" in
    .env|.env.*)
      if [ "$base" != ".env.example" ]; then
        echo "block-real-data: env file must not be committed: $f" >&2; fail=1
      fi ;;
  esac
  case "$f" in
    Documents/*|*/Documents/*|Originals/*|*/Originals/*)
      echo "block-real-data: filed document/statement path must not be committed: $f" >&2; fail=1 ;;
  esac
done

# Secret-shaped strings in text content. Long-token thresholds keep the
# short synthetic keys in the test suite (LLM_test, LLM_ask_secret_key)
# from tripping the guard; a real gateway key is far longer.
SECRET_RE='(LLM_[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
for f in "$@"; do
  [ -f "$f" ] || continue
  case "$f" in
    scripts/hooks/*) continue ;; # the guard's own pattern definitions
  esac
  if grep -Iq -E "$SECRET_RE" "$f" 2>/dev/null; then
    echo "block-real-data: secret-shaped string found in: $f" >&2; fail=1
  fi
  case "$(basename "$f")" in .env.example) continue ;; esac
  if grep -Iq -E '(OPENCODE_API_KEY|MUSE_API_KEY)[[:space:]]*=[[:space:]]*[^[:space:]#]{8,}' "$f" 2>/dev/null; then
    echo "block-real-data: API key assignment with a value found in: $f" >&2; fail=1
  fi
  # Real account identifiers (AH-108): savings account names carrying
  # real digits, UK sort-code shapes, and 8-digit numbers in account
  # context must never land in code or fixtures. The synthetic fixture
  # range (Savings-90000000xx) is the documented exception, mirroring
  # the short synthetic keys above; real identifiers live only in the
  # local account-identifiers.json outside the repo.
  if grep -Ioh -E 'Savings-[0-9]{6,}' "$f" 2>/dev/null | grep -vq -E '^Savings-9000[0-9]+$'; then
    echo "block-real-data: savings account identifier found in: $f" >&2; fail=1
  fi
  if grep -Iq -E '(^|[^0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}([^0-9]|$)' "$f" 2>/dev/null; then
    echo "block-real-data: sort-code-shaped string found in: $f" >&2; fail=1
  fi
  if grep -Ihi -E 'account[^[:cntrl:]]{0,40}[0-9]{8}' "$f" 2>/dev/null | grep -v 'Savings-9000' | grep -q .; then
    echo "block-real-data: account-number-shaped string in account context found in: $f" >&2; fail=1
  fi
done

exit "$fail"
