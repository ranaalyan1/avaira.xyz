#!/usr/bin/env python3
"""Capture the README/dashboard screenshots from a running server.

The committed PNGs under `verification/` were taken before the dual-theme
redesign, so they show the old dark styling. This regenerates them.

    make screenshots                      # builds, serves :3000, captures, tears down
    python3 tools/screenshots.py          # against an already-running :3000

Two honest caveats, because a screenshot is a claim:

* The five public routes (`/`, `/gate`, `/score`, `/evidence`, `/docs`) render
  with no backend at all.
* `/dashboard` and `/agents` sit behind `ProtectedRoute`. With no API attached the
  SPA redirects to `/login`, so those captures show the sign-in page — not a
  console that does not exist yet. Pass `--console` after the backend is up (and
  a session cookie is available) to capture the real console.

Requires Playwright with a chromium build:
    python3 -m pip install playwright && python3 -m playwright install chromium
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "verification"

PUBLIC = [
    ("/", "landing_v2.png", "landing"),
    ("/gate", "gate_v2.png", "pre-execution gate"),
    ("/score", "score_v2.png", "Avaira Score"),
    ("/evidence", "evidence_v2.png", "evidence"),
    ("/docs", "docs_v2.png", "protocol docs"),
]
CONSOLE = [
    ("/dashboard", "dashboard_v2.png", "dashboard"),
    ("/agents", "registry_v2.png", "agent registry"),
]


async def capture(base: str, pages: list[tuple[str, str, str]]) -> int:
    from playwright.async_api import async_playwright

    captured = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        for route, filename, label in pages:
            await page.goto(f"{base}{route}", wait_until="networkidle")
            await asyncio.sleep(1.5)  # let the entrance animations settle
            target = OUT / filename
            await page.screenshot(path=str(target), full_page=False)
            print(f"  captured {label:<22} {route:<11} → verification/{filename}")
            captured += 1
        await browser.close()
    return captured


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--console", action="store_true", help="also capture the authenticated console")
    args = ap.parse_args()

    try:
        import playwright  # noqa: F401
    except ImportError:
        print("  ✗ playwright is not installed — nothing captured.", file=sys.stderr)
        print("      python3 -m pip install playwright && python3 -m playwright install chromium", file=sys.stderr)
        return 1

    pages = PUBLIC + (CONSOLE if args.console else [])
    OUT.mkdir(exist_ok=True)
    try:
        count = asyncio.run(capture(args.base, pages))
    except Exception as exc:  # noqa: BLE001 - no chromium build, server down, etc.
        print(f"  ✗ capture failed: {type(exc).__name__}: {str(exc).splitlines()[0]}", file=sys.stderr)
        print("    Is the server running, and is chromium installed?", file=sys.stderr)
        return 1
    print(f"  ✓ {count} screenshot(s) written to verification/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
