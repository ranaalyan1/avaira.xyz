#!/usr/bin/env python3
"""Merge `campaign.py` shard reports into one matrix verdict.

    python3 tools/aggregate_campaigns.py verification/reports/campaign-shard-*.json \\
        --out verification/reports/campaign.json --title "campaign matrix"

Aggregating is only sound when every shard ran the *same bytecode*: the shard reports carry
`build.sourceDigest`, and this refuses to merge mismatched digests rather than quietly averaging
numbers from two different builds. That check is the whole reason this file exists.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("shards", nargs="+", help="shard report files written by campaign.py --out")
    ap.add_argument("--out", help="where to write the merged report")
    ap.add_argument("--title", default="campaign matrix")
    args = ap.parse_args(argv)

    reports = []
    for path in args.shards:
        with open(path) as fh:
            reports.append((os.path.basename(path), json.load(fh)))
    if not reports:
        print("no shard reports", file=sys.stderr)
        return 2

    digests = {r["build"]["sourceDigest"] for _, r in reports}
    if len(digests) > 1:
        print(
            "refusing to merge shards built from different bytecode:\n  "
            + "\n  ".join(f"{name}: {r['build']['sourceDigest'][:18]}…" for name, r in reports)
            + "\nrebuild once (node tools/compile.mjs) and re-run every shard",
            file=sys.stderr,
        )
        return 1

    violations = [v for _, r in reports for v in r["violations"]]
    per_invariant: dict[str, int] = {}
    for _, r in reports:
        for k, v in (r.get("invariantEvaluationsById") or {}).items():
            per_invariant[k] = per_invariant.get(k, 0) + v
    dead = sorted({i for _, r in reports for i in (r.get("invariantsNeverEvaluated") or [])})
    revert_kinds: dict[str, int] = {}
    by_error: dict[str, int] = {}
    for _, r in reports:
        for k, v in (r.get("revertKinds") or {}).items():
            revert_kinds[k] = revert_kinds.get(k, 0) + v
            # Shards key their histogram by fully decoded revert (name + args + file:line), which is
            # the right granularity for replaying one. For a *matrix* view we want the error, so fold
            # on the name (and its declaring contract, which follows in the `[...]` suffix).
            name = k.split("(", 1)[0].strip()
            if not name or name == "reverted":
                name = "(undecoded revert)"
            contract = k.rsplit("[", 1)[1].rstrip("] ") if "[" in k else ""
            by_error[f"{name} [{contract}]" if contract else name] = by_error.get(f"{name} [{contract}]", 0) + v
    by_error = dict(sorted(by_error.items(), key=lambda kv: -kv[1])[:25])

    merged = {
        "schema": "avaira.campaign-matrix/v1",
        "title": args.title,
        "verdict": "PASS" if all(r["verdict"] == "PASS" for _, r in reports) and not violations and not dead else "FAIL",
        "build": reports[0][1]["build"],
        "shards": [
            {
                "file": name,
                "seed": r["seed"],
                "verdict": r["verdict"],
                "sequences": r["sequences"],
                "depth": r["depth"],
                "calls": r["calls"],
                "reverts": r["reverts"],
                "invariantEvaluations": r["invariantEvaluations"],
                "violations": len(r["violations"]),
                "elapsedSeconds": r["elapsedSeconds"],
                "throughputCallsPerSecond": r["throughputCallsPerSecond"],
            }
            for name, r in reports
        ],
        "totals": {
            "shards": len(reports),
            "sequences": sum(r["sequences"] for _, r in reports),
            "calls": sum(r["calls"] for _, r in reports),
            "reverts": sum(r["reverts"] for _, r in reports),
            "invariantEvaluations": sum(r["invariantEvaluations"] for _, r in reports),
            "violations": len(violations),
            "elapsedSeconds": round(sum(r["elapsedSeconds"] for _, r in reports), 1),
        },
        "invariants": reports[0][1]["invariants"],
        "invariantEvaluationsById": dict(sorted(per_invariant.items())),
        "invariantsNeverEvaluated": dead,
        "revertKinds": dict(sorted(revert_kinds.items(), key=lambda kv: -kv[1])[:20]),
        "revertKindsByError": by_error,
        "revertDecodeCoverage": (
            round(100 * (1 - by_error.get("(undecoded revert)", 0) / max(1, sum(by_error.values()))), 1)
        ),
        "violations": violations[:20],
    }

    text = json.dumps(merged, indent=2, sort_keys=True) + "\n"
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w") as fh:
            fh.write(text)
    t = merged["totals"]
    print(
        f"{args.title} {merged['verdict']}  {t['shards']} shards  {t['sequences']} sequences  "
        f"{t['calls']} calls ({t['reverts']} reverted)  {t['invariantEvaluations']} invariant evaluations  "
        f"{t['violations']} violations"
    )
    print(f"  decoded reverts: {merged['revertDecodeCoverage']}% named  ·  top: "
          + ", ".join(f"{k.split('[')[0].strip()}×{v}" for k, v in list(merged['revertKindsByError'].items())[:3]))
    if dead:
        print("  invariants declared but never evaluated: " + ", ".join(dead), file=sys.stderr)
    return 0 if merged["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
