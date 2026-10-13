#!/usr/bin/env python3
"""Live-deploy gate — asserts that a deployed URL is really serving AVAIRA.

`tools/doctor.py` guards the claims in the docs; this guards the *deployment*.
Run it after a Vercel deploy and it fails loudly when the URL is Vercel's 404
page, a stale build, or an SPA whose deep links 404 on refresh — the three ways
a "successful" deploy still leaves users with a broken site.

    python3 tools/verify_deploy.py                                  # https://avaira.vercel.app
    python3 tools/verify_deploy.py https://avaira-git-main.vercel.app
    python3 tools/verify_deploy.py --json verification/reports/deployed.json

Exit 0 = every check passed, 1 = at least one FAIL. The URL can also come from
`AVAIRA_DEPLOY_URL`, which is what `make verify-deploy` uses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_URL = "https://avaira.vercel.app"
ROOT = Path(__file__).resolve().parents[1]

# Deep links a visitor can land on directly (shared link, bookmark, refresh).
# Each one has to come back as the SPA shell, not a 404.
DEEP_LINKS = ("/gate", "/score", "/evidence", "/docs")

# Fingerprints of Vercel's own not-found page. If the root responds with one of
# these, the project is missing/renamed/not connected — nothing to do with the
# frontend build, and the error message says so instead of blaming the bundle.
VERCEL_404_MARKERS = (
    "404: NOT_FOUND",
    "This page doesn\u2019t exist",
    "This page doesn't exist",
    "DEPLOYMENT_NOT_FOUND",
)

UA = "avaira-verify-deploy/1.0 (+https://github.com/ranaalyan1/avaira.xyz)"
TIMEOUT = 20
MIN_JS_BYTES = 200_000  # the gzipped-off main bundle is ~1.0 MB; anything tiny is an error page


@dataclass
class Response:
    url: str
    status: int
    body: bytes
    content_type: str

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    fatal: bool = True

    @property
    def status(self) -> str:
        if self.ok:
            return "PASS"
        return "FAIL" if self.fatal else "WARN"


def fetch(url: str) -> Response | None:
    """GET a URL. Non-2xx comes back as a Response (status preserved); only
    transport-level failures return None."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return Response(url, r.status, r.read(), r.headers.get("Content-Type", ""))
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:  # pragma: no cover - body unavailable
            pass
        return Response(url, e.code, body, (e.headers or {}).get("Content-Type", ""))
    except Exception:
        return None


def check_root(base: str) -> tuple[list[Check], Response | None]:
    checks: list[Check] = []
    root = fetch(base + "/")
    if root is None:
        checks.append(
            Check(
                "GET / responds",
                False,
                f"no response from {base}/ — unreachable or TLS failure "
                "(an egress-filtered environment such as a CI sandbox will also look like this)",
            )
        )
        return checks, None

    reachable = root.status == 200 and "text/html" in root.content_type
    checks.append(
        Check(
            "GET / returns 200 HTML",
            reachable,
            f"status={root.status} content-type={root.content_type or 'none'}",
        )
    )

    is_vercel_404 = any(m in root.text for m in VERCEL_404_MARKERS)
    checks.append(
        Check(
            "serving the app, not Vercel's 404 page",
            not is_vercel_404,
            "response body is Vercel's NOT_FOUND page" if is_vercel_404 else "no NOT_FOUND fingerprint in the body",
        )
    )

    title_match = re.search(r"<title>(.*?)</title>", root.text, re.S | re.I)
    title = (title_match.group(1).strip() if title_match else "")
    checks.append(
        Check(
            "document has the AVAIRA <title>",
            bool(title) and "AVAIRA" in title.upper(),
            f"<title> = {title!r}" if title else "no <title> element in the served HTML",
        )
    )
    return checks, root


def check_deep_links(base: str, shell: Response) -> list[Check]:
    """The SPA rewrite: every deep link must return the same shell bytes as `/`.
    A build without the rewrite returns Vercel/nginx 404s here, which is how a
    shared dashboard link breaks even though the homepage looks fine."""
    checks: list[Check] = []
    for path in DEEP_LINKS:
        r = fetch(base + path)
        if r is None:
            checks.append(Check(f"deep link {path}", False, "no response"))
            continue
        same_shell = r.status == 200 and r.body == shell.body
        checks.append(
            Check(
                f"deep link {path} serves the SPA shell",
                same_shell,
                f"status={r.status}, {len(r.body)}B vs shell {len(shell.body)}B",
            )
        )
    return checks


def check_assets(base: str, shell: Response) -> list[Check]:
    checks: list[Check] = []
    html = shell.text

    js_refs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    css_refs = re.findall(r'<link[^>]+href="([^"]+\.css)"', html)
    # CRA inlines a tiny runtime loader; the real bundle is the /static/js/main.*.js one.
    main_js = [u for u in js_refs if "/static/js/" in u]

    if not main_js:
        checks.append(Check("bundle is referenced by the shell", False, "no /static/js/* script tag in the HTML"))
    else:
        url = main_js[0] if main_js[0].startswith("http") else base + main_js[0]
        r = fetch(url)
        size = len(r.body) if r else 0
        checks.append(
            Check(
                "main JS bundle downloads",
                bool(r) and r.status == 200 and size >= MIN_JS_BYTES,
                f"{url.rsplit('/', 1)[-1]}: status={r.status if r else 'none'}, "
                f"{size}B (need >= {MIN_JS_BYTES}B)",
            )
        )

    if not css_refs:
        checks.append(Check("CSS is referenced by the shell", False, "no .css link tag in the HTML"))
    else:
        url = css_refs[0] if css_refs[0].startswith("http") else base + css_refs[0]
        r = fetch(url)
        checks.append(
            Check(
                "CSS bundle downloads",
                bool(r) and r.status == 200 and len(r.body) > 1_000,
                f"{url.rsplit('/', 1)[-1]}: status={r.status if r else 'none'}, {len(r.body) if r else 0}B",
            )
        )
    return checks


def check_static_files(base: str) -> list[Check]:
    """robots.txt / sitemap.xml are committed in frontend/public. Missing ones
    are a WARN, not a FAIL: the site still works, but crawlers lose the map."""
    checks: list[Check] = []
    for path in ("/robots.txt", "/sitemap.xml"):
        r = fetch(base + path)
        ok = bool(r) and r.status == 200 and len(r.body) > 0
        checks.append(Check(f"static file {path}", ok, f"status={r.status if r else 'none'}", fatal=False))
    return checks


def build_report(url: str) -> tuple[list[Check], dict]:
    base = url.rstrip("/")
    checks, shell = check_root(base)

    # Order matters: Vercel serves its NOT_FOUND page with HTTP 404, so the
    # fingerprint has to be tested before the status, or a missing deployment
    # gets misreported as a network problem.
    if shell is None:
        verdict = "unreachable"
        return checks, {"url": base, "verdict": verdict, "status": None}
    if any(m in shell.text for m in VERCEL_404_MARKERS):
        return checks, {"url": base, "verdict": "not-deployed", "status": shell.status}
    if shell.status != 200:
        return checks, {"url": base, "verdict": "error", "status": shell.status}

    checks += check_deep_links(base, shell)
    checks += check_assets(base, shell)
    checks += check_static_files(base)
    verdict = "ok" if all(c.ok or not c.fatal for c in checks) else "broken"
    return checks, {"url": base, "verdict": verdict, "status": shell.status}


def remediation(verdict: str, url: str, status: int | None = None) -> list[str]:
    if verdict == "not-deployed":
        return [
            f"{url}/ answered with Vercel's NOT_FOUND page, so nothing is deployed on that name.",
            "The frontend build is not the problem — the Vercel project is missing, renamed, or no",
            "longer connected to this repository. See docs/deploy-vercel.md → \"Where things stand\"",
            "and pick one of the two routes there (rename the existing project, or import it fresh).",
        ]
    if verdict == "unreachable":
        return [
            f"No HTTP response from {url}/.",
            "If you are running this from a network-restricted sandbox, that is expected and says",
            "nothing about the deployment — rerun it from a machine with open egress, or from CI.",
        ]
    if verdict == "error":
        return [
            f"{url}/ answered HTTP {status} instead of the app.",
            "The deployment exists but is not serving the SPA — check the Vercel build logs for this",
            "commit, and confirm outputDirectory points at a directory the build actually produced.",
        ]
    if verdict == "broken":
        return [
            "The URL answered, but at least one check failed. The failing check above names the",
            "cause: a stale build has the wrong bundle hash, a missing rewrite breaks deep links,",
            "and a missing bundle means outputDirectory points at an empty directory.",
        ]
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("url", nargs="?", default=os.environ.get("AVAIRA_DEPLOY_URL", DEFAULT_URL))
    ap.add_argument("--json", metavar="PATH", help="also write the report as JSON")
    args = ap.parse_args()

    checks, meta = build_report(args.url)
    failures = [c for c in checks if not c.ok and c.fatal]

    width = max(len(c.name) for c in checks)
    for c in checks:
        print(f"  {c.status}  {c.name.ljust(width)}  {c.detail}")

    if meta["verdict"] == "ok":
        print(f"\n  ✓ {meta['url']} is serving AVAIRA ({len(checks)} checks)")
    else:
        print(f"\n  ✗ {meta['url']}: {meta['verdict']} — {len(failures)} failing check(s)")
        for line in remediation(meta["verdict"], meta["url"], meta.get("status")):
            print(f"    {line}")

    report = {
        "url": meta["url"],
        "verdict": meta["verdict"],
        "status": meta.get("status"),
        "checks": [{"name": c.name, "status": c.status, "detail": c.detail} for c in checks],
        "failures": [c.name for c in failures],
    }
    if args.json:
        out = Path(args.json)
        if not out.is_absolute():
            out = ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + "\n")
        try:
            shown = out.relative_to(ROOT)
        except ValueError:  # --json /tmp/… is allowed; just print it as given
            shown = out
        print(f"    report → {shown}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
