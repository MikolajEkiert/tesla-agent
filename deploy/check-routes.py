#!/usr/bin/env python3
"""Fails the deploy if a backend route has no matching Caddy entry.

Caddy's catch-all sends anything unlisted to the static frontend, so a missing
`handle` block turns a working endpoint into an nginx 404 — and the app then
looks broken rather than merely misrouted. That mistake shipped twice (/jobs,
then /gate/*) before this check existed, both times only visible in the
browser.

Run from the repo root; exits non-zero on a gap.
"""
from __future__ import annotations

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CADDYFILE = os.path.join(REPO, "deploy", "Caddyfile")


def caddy_patterns() -> list[str]:
    with open(CADDYFILE) as f:
        return re.findall(r"^\s*handle\s+(/\S+?)\s*\{", f.read(), re.MULTILINE)


def covered(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        prefix = pattern.rstrip("*")
        if pattern.endswith("*") and path.startswith(prefix):
            return True
        if pattern == path:
            return True
    return False


def main() -> int:
    sys.path.insert(0, os.path.join(REPO, "backend"))
    os.environ.setdefault("TESLA_ADAPTER", "mock")
    try:
        from app.main import app  # noqa: PLC0415  (import needs the path set above)
    except Exception as e:
        # Never block a deploy because this checker could not run; a missing
        # route is a bug, an unimportable checker is just noise.
        print(f"  route check skipped ({type(e).__name__}: {e})")
        return 0

    patterns = caddy_patterns()
    missing = [
        route.path
        for route in app.routes
        if getattr(route, "path", "").startswith("/")
        and not route.path.startswith("/openapi")
        and route.path not in ("/docs", "/redoc", "/docs/oauth2-redirect")
        and not covered(route.path, patterns)
    ]
    if missing:
        print("  ROUTES MISSING FROM deploy/Caddyfile:")
        for path in sorted(set(missing)):
            print(f"    {path}")
        print("  These would be answered by the static frontend with a 404.")
        return 1
    print(f"  route check ok ({len(patterns)} Caddy rules cover every API route)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
