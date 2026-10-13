#!/usr/bin/env python3
"""Merge forge broadcast receipts into the deployment manifest.

`contracts/script/Deploy.s.sol` writes `deployments/{chainId}.json` with the
addresses, because that is all a script knows at write time. The transaction
hashes live in forge's own broadcast record
(`contracts/broadcast/Deploy.s.sol/{chainId}/run-latest.json`), which is what a
judge, an explorer link or a block explorer scan needs.

This copies them in, additively:

    deployments/10143.json
      + "deployer":        "0x…"                       (from the broadcast `from`)
      + "deploymentTxs":   { "AvairaIdentityRegistry": "0x…", … }   (CREATE only)
      + "deploymentBlock": already written by the script

Identity-matching is the point. A `CREATE` receipt is only merged when its
`contractAddress` equals the address the manifest records for that contract — if
they disagree, the merge aborts rather than attaching a real-looking hash to the
wrong contract. Addresses that the broadcast does not cover are listed in
`deploymentTxsMissing`, so a partial merge is visible instead of implied.

    python3 tools/merge_deploy_txs.py --chain 10143
    python3 tools/merge_deploy_txs.py --chain 10143 --check   # verify only, write nothing

Called automatically by `contracts/scripts/deploy-monad.sh` right after the
broadcast; run it by hand to repair an older manifest. Exit 0 = merged or already
consistent, non-zero = a mismatch worth reading.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Manifest key → the contract name forge records in the broadcast.
CONTRACTS = {
    "identityRegistry": "AvairaIdentityRegistry",
    "reputationRegistry": "AvairaReputationRegistry",
    "validationRegistry": "AvairaValidationRegistry",
    "stakeRegistry": "AvairaStakeRegistry",
    "intentVault": "AvairaIntentVault",
    "creditMarket": "AvairaCreditMarket",
    "settlementToken": "MockUSDC",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def collect_creates(broadcast: dict) -> dict[str, dict]:
    """contractName → its CREATE receipt (hash, address, txIndex)."""
    out: dict[str, dict] = {}
    for tx in broadcast.get("transactions") or []:
        name = tx.get("contractName")
        if not name or tx.get("transactionType") != "CREATE":
            continue
        # A redeploy of the same script in one broadcast would repeat a name; keep the last,
        # which is what the manifest (also last-write-wins) refers to.
        out[name] = {
            "hash": tx.get("hash"),
            "contractAddress": tx.get("contractAddress"),
            "from": tx.get("transaction", {}).get("from") if isinstance(tx.get("transaction"), dict) else tx.get("from"),
        }
    return out


def merge(manifest: dict, creates: dict[str, dict]) -> tuple[dict, list[str], list[str]]:
    """Returns (manifest, missing, mismatched). Pure — the tests use this directly."""
    txs: dict[str, str] = dict(manifest.get("deploymentTxs") or {})
    missing: list[str] = []
    mismatched: list[str] = []

    for key, name in CONTRACTS.items():
        expected = (manifest.get(key) or "").lower()
        receipt = creates.get(name)
        if not receipt or not receipt.get("hash"):
            missing.append(name)
            continue
        actual = (receipt.get("contractAddress") or "").lower()
        if expected and actual and actual != expected:
            mismatched.append(f"{name}: broadcast says {actual}, manifest says {expected}")
            continue
        txs[name] = receipt["hash"]

    if txs:
        manifest["deploymentTxs"] = txs
    deployers = {r["from"] for r in creates.values() if r.get("from")}
    if len(deployers) == 1 and not manifest.get("deployer"):
        manifest["deployer"] = deployers.pop()
    return manifest, missing, mismatched


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--chain", type=int, default=10143)
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--broadcast", default=None)
    ap.add_argument("--check", action="store_true", help="report consistency without writing")
    args = ap.parse_args(argv)

    manifest_path = Path(args.manifest) if args.manifest else ROOT / "deployments" / f"{args.chain}.json"
    broadcast_path = (
        Path(args.broadcast)
        if args.broadcast
        else ROOT / "contracts" / "broadcast" / "Deploy.s.sol" / str(args.chain) / "run-latest.json"
    )

    if not manifest_path.exists():
        print(f"  ✗ no manifest at {manifest_path} — run make deploy-monad first", file=sys.stderr)
        return 1
    if not broadcast_path.exists():
        print(f"  ✗ no broadcast record at {broadcast_path}", file=sys.stderr)
        print("    forge writes this during --broadcast; without it the tx hashes are unrecoverable", file=sys.stderr)
        return 1

    manifest = load_json(manifest_path)
    creates = collect_creates(load_json(broadcast_path))
    merged, missing, mismatched = merge(manifest, creates)

    if mismatched:
        print("  ✗ broadcast and manifest disagree — refusing to write:", file=sys.stderr)
        for line in mismatched:
            print(f"      {line}", file=sys.stderr)
        return 1

    have = len(merged.get("deploymentTxs") or {})
    total = len(CONTRACTS)
    if args.check:
        ok = have == total and not missing
        print(f"  {'PASS' if ok else 'FAIL'}  {have}/{total} contracts carry a deploy tx hash in {manifest_path.name}")
        if missing:
            print(f"        missing: {', '.join(missing)}")
        return 0 if ok else 1

    manifest_path.write_text(json.dumps(merged, indent=2, sort_keys=False) + "\n")
    try:
        shown = manifest_path.relative_to(ROOT)
    except ValueError:  # an explicit --manifest may live outside the repo
        shown = manifest_path
    print(f"  ✓ merged {have}/{total} deploy tx hashes into {shown}")
    if missing:
        print(f"    ! no CREATE receipt for: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
