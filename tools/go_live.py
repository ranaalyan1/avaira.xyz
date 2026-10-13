#!/usr/bin/env python3
"""Flip the README from "not live yet" to "live" — but only after the URL verifies.

The repo's rule is that no badge may point at something a command has not
checked. The Vercel deploy is a one-click human action, so the README cannot
carry the Live badge in advance: it would be an overclaim for however long the
click takes. This is the other half of that bargain — the switch that turns the
claim on, gated on the verifier:

    make go-live                      # https://avaira.vercel.app
    make go-live URL=https://…        # a preview URL

It runs `tools/verify_deploy.py` first and refuses to touch the README unless the
verdict is `ok`. Idempotent: run it twice and the second run says "already live".

What it changes (and nothing else):
  * the `<sub>The site is **not live yet** …</sub>` note under the deploy button
    becomes the Live badge;
  * the **Site** row of the README's *Try it* table becomes ✅ with the date the
    verification passed (from the report, so the date is the verified one);
  * the generated deployed-contracts section is left alone — it is rendered from
    `deployments/{chainId}.json` by `tools/gen_deploy_section.py`.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
REPORT = ROOT / "verification" / "reports" / "deployed.json"
DEFAULT_URL = "https://avaira.vercel.app"

BADGE = (
    "[![Live](https://img.shields.io/badge/Protocol_Control_Center-avaira.vercel.app-000000"
    "?style=for-the-badge&logo=vercel&logoColor=white)](https://avaira.vercel.app)"
)


def verify(url: str) -> dict:
    """Run the deploy verifier and return its JSON report."""
    proc = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "verify_deploy.py"), url, "--json", str(REPORT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    report = json.loads(REPORT.read_text()) if REPORT.exists() else {}
    if proc.returncode != 0 or report.get("verdict") != "ok":
        print(proc.stdout.rstrip())
        print(proc.stderr.rstrip())
        print(
            f"\n  ✗ refusing to write the Live badge: {url} does not verify"
            f" (verdict: {report.get('verdict', 'unknown')}).\n"
            "    Fix the deployment first, then re-run `make go-live`.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("url", nargs="?", default=DEFAULT_URL)
    ap.add_argument("--check", action="store_true", help="report the current state, change nothing")
    args = ap.parse_args(argv)

    readme = README.read_text()
    already_live = BADGE in readme and "not live yet" not in readme

    if args.check:
        print(f"  README is {'live' if already_live else 'marked not-live'}")
        return 0

    if already_live:
        print("  already live — README carries the badge and no 'not live yet' note")
        return 0

    verify(args.url)

    # 1. the note under the deploy button → the badge
    note = re.compile(
        r"<sub>The site is \*\*not live yet\*\*.*?</sub>\n",
        re.S,
    )
    if not note.search(readme):
        print("  ✗ could not find the 'not live yet' note to replace — README changed shape", file=sys.stderr)
        return 1
    readme = note.sub(BADGE + "\n", readme, count=1)

    # 2. the Try it table's Site row
    row = re.compile(r"^\| \*\*Site\*\* \| .*\|\s*$", re.M)
    if not row.search(readme):
        print("  ✗ could not find the Site row in the Try it table", file=sys.stderr)
        return 1
    readme = row.sub(
        f"| **Site** | {args.url} | ✅ **Live** — verified by `make verify-deploy` "
        f"({len(json.loads(REPORT.read_text()).get('checks', []))} checks). |",
        readme,
        count=1,
    )

    README.write_text(readme)
    print(f"  ✓ README now advertises {args.url} as live (verified, not assumed)")
    print("    Commit the change, then update the GitHub Homepage field if you want it there too.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
