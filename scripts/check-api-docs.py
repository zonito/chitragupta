#!/usr/bin/env python3
"""API-docs coverage and consistency gate (AH-086).

Re-derives the HTTP inventory from the routing code and diffs it against
openapi.yaml (both directions), then checks that postman_collection.json
is structurally valid Postman Collection v2.1 and matches the spec's
paths and methods one for one. Also validates the spec with
openapi-spec-validator when it is installed.

Usage:
    python3 scripts/check-api-docs.py

Exits 0 when the diff is empty and every check passes; 1 otherwise.
Requires PyYAML. The OpenAPI validation step requires
openapi-spec-validator (skip with --skip-spec-validate).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_TS = ROOT / "src" / "lib" / "api.ts"
ROUTES_DIR = ROOT / "src" / "routes"
SPEC = ROOT / "openapi.yaml"
COLLECTION = ROOT / "postman_collection.json"

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}


def code_inventory() -> set[tuple[str, str]]:
    """(METHOD, path) pairs from the routing code, template paths kept."""
    out: set[tuple[str, str]] = set()
    src = API_TS.read_text(encoding="utf-8")
    # Direct registrations: if (path === "/api/..." && request.method === "X")
    for path, method in re.findall(
        r'path === "(/api/[^"]+)" && request\.method === "([A-Z]+)"', src
    ):
        out.add((method, path))
    # The blind Jev proxy is method-checked inside routeJev.
    if 'path === "/api/jev/ask"' in src and 'request.method !== "POST"' in src:
        out.add(("POST", "/api/jev/ask"))
    # The document file download is a regex route.
    if re.search(r"/\^\\/api\\/documents\\/", src) and 'request.method === "GET"' in src:
        out.add(("GET", "/api/documents/{id}/file"))
    # File-based page routes: every src/routes/*.tsx except the root layout.
    for f in sorted(ROUTES_DIR.glob("*.tsx")):
        if f.name == "__root.tsx":
            continue
        slug = f.stem
        out.add(("GET", "/" if slug == "index" else f"/{slug}"))
    return out


def spec_inventory(spec: dict) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for path, item in (spec.get("paths") or {}).items():
        for method in item:
            if method.lower() in HTTP_METHODS:
                out.add((method.upper(), path))
    return out


def collection_ops(col: dict) -> list[tuple[str, str]]:
    ops: list[tuple[str, str]] = []

    def walk(items: list) -> None:
        for it in items or []:
            if "item" in it:
                walk(it["item"])
            elif "request" in it:
                req = it["request"]
                method = str(req.get("method", "")).upper()
                url = req.get("url") or {}
                if isinstance(url, dict):
                    raw = "/" + "/".join(str(p) for p in url.get("path", []))
                else:
                    raw = str(url)
                raw = raw.replace("{{baseUrl}}", "")
                raw = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", raw)
                if raw in ("", "/"):
                    raw = "/"
                ops.append((method, raw))

    walk(col.get("item") or [])
    return ops


def main() -> int:
    try:
        import yaml
    except ImportError:
        print("check-api-docs: PyYAML is required (pip install pyyaml)", file=sys.stderr)
        return 1

    skip_spec = "--skip-spec-validate" in sys.argv
    failures: list[str] = []

    spec = yaml.safe_load(SPEC.read_text(encoding="utf-8"))
    if not isinstance(spec, dict) or "paths" not in spec:
        print("check-api-docs: openapi.yaml has no paths", file=sys.stderr)
        return 1

    # 1. Spec validation (standard OpenAPI validator).
    if not skip_spec:
        try:
            from openapi_spec_validator import validate

            validate(spec)
            print("spec validation: OK (openapi-spec-validator)")
        except ImportError:
            print(
                "spec validation: SKIPPED (openapi-spec-validator not installed; "
                "install with: pip install openapi-spec-validator)",
                file=sys.stderr,
            )
            failures.append("spec validator unavailable")
        except Exception as e:  # validator verdict
            print(f"spec validation: FAILED: {e}", file=sys.stderr)
            failures.append("spec validation failed")

    # 2. Coverage diff: code inventory vs spec, both directions.
    code_ops = code_inventory()
    spec_ops = spec_inventory(spec)
    missing = sorted(code_ops - spec_ops)
    extra = sorted(spec_ops - code_ops)
    print(f"coverage: code={len(code_ops)} ops, spec={len(spec_ops)} ops")
    for m, p in missing:
        print(f"  MISSING from spec: {m} {p}", file=sys.stderr)
    for m, p in extra:
        print(f"  NOT in code (documented but does not exist): {m} {p}", file=sys.stderr)
    if missing or extra:
        failures.append(f"coverage diff non-zero (missing={len(missing)}, extra={len(extra)})")
    else:
        print("coverage diff: zero (both directions)")

    # 3. Collection: structural v2.1 + one-for-one with the spec.
    col = json.loads(COLLECTION.read_text(encoding="utf-8"))
    info = col.get("info") or {}
    schema = str(info.get("schema", ""))
    if "v2.1" not in schema:
        failures.append(f"collection schema is not v2.1: {schema!r}")
        print(f"collection schema: BAD ({schema!r})", file=sys.stderr)
    else:
        print(f"collection schema: OK ({schema})")
    for key in ("info", "item"):
        if key not in col:
            failures.append(f"collection missing '{key}'")
    col_ops = collection_ops(col)
    if sorted(col_ops) != sorted(spec_ops):
        failures.append("collection requests do not match spec paths/methods one for one")
        print(
            f"collection match: FAILED (collection={len(col_ops)}, spec={len(spec_ops)})",
            file=sys.stderr,
        )
        for op in sorted(set(col_ops) ^ set(spec_ops)):
            print(f"  differs: {op}", file=sys.stderr)
    else:
        print(f"collection match: OK ({len(col_ops)} requests, one per spec operation)")

    if failures:
        print("check-api-docs: FAILED — " + "; ".join(failures), file=sys.stderr)
        return 1
    print("check-api-docs: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
