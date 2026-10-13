#!/usr/bin/env python3
"""Monad deployment liveness — the loud failure that an undeployed stack deserves.

`make deploy-monad` writes `deployments/{chainId}.json`. This is the check that
runs *after* it, and the one a judge runs to confirm the submission is real:

    python3 tools/verify_monad.py                 # chain 10143, from the manifest
    python3 tools/verify_monad.py --chain 143
    python3 tools/verify_monad.py --rpc https://testnet-rpc.monad.xyz --json report.json

For every contract in the manifest it asserts three things:

1. **the address has bytecode** (`eth_getCode`) — a dead or never-deployed address
   fails here rather than in a transaction;
2. **a cheap view getter answers** (`eth_call`) — bytecode alone would pass for a
   contract that reverts on everything;
3. **the answer is the expected one** — the getters point at the sibling addresses
   and parameters recorded in the manifest, so "the right contract is at the right
   address, correctly wired" is proven, not assumed.

It also checks `eth_chainId` against the manifest, so pointing `--rpc` at the wrong
network (or a mainnet endpoint) is reported as a chain mismatch instead of a wall of
"no code at address".

Deliberately stdlib-only: no web3, no node, no Foundry. It runs on a clean checkout,
in CI, or on a judge's laptop. Function selectors are the keccak-4 of the signatures
below; they are cross-checked against `audit/specs/*.md` (e.g. `0x38d52e0f asset()`,
`0x134e18f4 identityRegistry()`) and a wrong selector fails *closed* — the getter
check reports a problem rather than silently passing.

Exit 0 = every contract is present, answering, and correctly wired.
Exit 1 = undeployed, unreachable, wrong chain, or a broken/dead address.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_CHAIN_ID = 10143
RPC_BY_CHAIN = {
    10143: "https://testnet-rpc.monad.xyz",
    143: "https://rpc.monad.xyz",
}
EXPLORER_BY_CHAIN = {
    10143: "https://testnet.monadscan.com",
    143: "https://monadscan.com",
}
RPC_ENV_BY_CHAIN = {10143: "MONAD_TESTNET_RPC", 143: "MONAD_MAINNET_RPC"}

# keccak4(signature). Only addresses and integers — no strings, so no ABI decoder is
# needed and the whole tool stays stdlib.
SEL = {
    "decimals()": "0x313ce567",
    "enforcer()": "0x0d14a0e2",
    "registrationBond()": "0x373b9dbd",
    "treasury()": "0x61d027b3",
    "identityRegistry()": "0x134e18f4",
    "stakeRegistry()": "0x68304835",
    "settlementToken()": "0x7b9e618d",
    "minGroundedPayment()": "0xc72da6a4",
    "stakeToken()": "0x51ed6a30",
    "minStake()": "0x375b3c0a",
    "minScore()": "0x13c2bedc",
    "challengeWindow()": "0x861a1412",
    "challengerBond()": "0x68ccdc86",
    "asset()": "0x38d52e0f",
    "totalLiquidity()": "0x15770f92",
}

ZERO = "0x" + "0" * 40
TIMEOUT = 25


@dataclass
class Finding:
    contract: str
    address: str
    code_bytes: int | None
    answered: dict = field(default_factory=dict)
    problems: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.code_bytes is not None and self.code_bytes > 0 and not self.problems


class RpcError(RuntimeError):
    pass


class Rpc:
    """Minimal JSON-RPC client. Raises RpcError on transport or protocol failure."""

    def __init__(self, url: str, timeout: int = TIMEOUT):
        self.url = url
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params: list):
        self._id += 1
        payload = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
        req = urllib.request.Request(
            self.url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "avaira-verify-monad/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            raise RpcError(f"HTTP {exc.code} from {self.url}") from exc
        except Exception as exc:  # noqa: BLE001 - unreachable host, DNS, TLS, timeout
            raise RpcError(f"no response from {self.url} ({type(exc).__name__})") from exc
        if "error" in body:
            raise RpcError(f"{method}: {body['error'].get('message', body['error'])}")
        return body.get("result")


def decode_word(result: str) -> int:
    """One 32-byte word → int. Empty result (a revert) decodes to 0."""
    if not result or result in ("0x", "0x0"):
        return 0
    return int(result, 16)


def decode_address(result: str) -> str:
    word = decode_word(result)
    return "0x" + word.to_bytes(20, "big").hex() if word else ZERO


def _expect(finding: Finding, got: str | int, want: str | int | None, label: str, sig: str) -> None:
    if want is None:
        return  # the manifest does not pin this value; presence is all we can check
    if isinstance(want, str):
        if want.lower() == ZERO:
            return
        if str(got).lower() != want.lower():
            finding.problems.append(f"{sig} = {got}, manifest says {want}")
    elif int(got) != int(want):
        finding.problems.append(f"{sig} = {got}, manifest says {want}")


def check_contract(
    rpc: Rpc, name: str, address: str, getters: dict[str, tuple[str, str | int | None]], manifest: dict
) -> Finding:
    finding = Finding(name, address, None)
    if not address or address.lower() == ZERO:
        finding.problems.append("manifest has no address for this contract")
        return finding

    try:
        code = rpc.call("eth_getCode", [address, "latest"])
    except RpcError as exc:
        finding.problems.append(str(exc))
        return finding
    code = code or "0x"
    finding.code_bytes = max(0, (len(code) - 2) // 2)
    if finding.code_bytes == 0:
        finding.problems.append("no bytecode at this address — not deployed, or wrong address")

    for sig, (kind, want) in getters.items():
        selector = SEL[sig]
        try:
            raw = rpc.call("eth_call", [{"to": address, "data": selector}, "latest"])
        except RpcError as exc:
            finding.problems.append(f"{sig}: {exc}")
            continue
        if not raw or raw == "0x":
            finding.problems.append(f"{sig} returned nothing (revert or not the expected contract)")
            continue
        got: str | int = decode_address(raw) if kind == "address" else decode_word(raw)
        finding.answered[sig] = got
        _expect(finding, got, want, name, sig)
    return finding


def build_checks(manifest: dict) -> list[tuple[str, str, dict]]:
    """(contract name, address, getters) in deploy order, expectations straight from the manifest."""
    identity = manifest.get("identityRegistry", ZERO)
    stake = manifest.get("stakeRegistry", ZERO)
    usdc = manifest.get("settlementToken", ZERO)
    return [
        (
            "MockUSDC",
            usdc,
            {"decimals()": ("uint", 6)},
        ),
        (
            "AvairaIdentityRegistry",
            identity,
            {
                "enforcer()": ("address", stake),
                "registrationBond()": ("uint", manifest.get("registrationBond")),
                "treasury()": ("address", manifest.get("treasury")),
            },
        ),
        (
            "AvairaReputationRegistry",
            manifest.get("reputationRegistry", ZERO),
            {
                "identityRegistry()": ("address", identity),
                "stakeRegistry()": ("address", stake),
                "settlementToken()": ("address", usdc),
                "minGroundedPayment()": ("uint", manifest.get("minGroundedPayment")),
            },
        ),
        (
            "AvairaValidationRegistry",
            manifest.get("validationRegistry", ZERO),
            {"identityRegistry()": ("address", identity)},
        ),
        (
            "AvairaStakeRegistry",
            stake,
            {
                "identityRegistry()": ("address", identity),
                "stakeToken()": ("address", usdc),
                "minStake()": ("uint", manifest.get("minStake")),
                "minScore()": ("uint", manifest.get("minScore")),
            },
        ),
        (
            "AvairaIntentVault",
            manifest.get("intentVault", ZERO),
            {
                "identityRegistry()": ("address", identity),
                "stakeRegistry()": ("address", stake),
                "stakeToken()": ("address", usdc),
                "challengeWindow()": ("uint", manifest.get("challengeWindow")),
                "challengerBond()": ("uint", manifest.get("challengerBond")),
            },
        ),
        (
            "AvairaCreditMarket",
            manifest.get("creditMarket", ZERO),
            {
                "identityRegistry()": ("address", identity),
                "stakeRegistry()": ("address", stake),
                "asset()": ("address", usdc),
            },
        ),
    ]


def instruction(chain_id: int) -> list[str]:
    explorer = EXPLORER_BY_CHAIN.get(chain_id, "the explorer")
    return [
        f"deployments/{chain_id}.json does not exist — nothing is deployed on chain {chain_id} yet.",
        "",
        "  To deploy (three steps, needs a funded key):",
        "    1. Fund a wallet at https://faucet.monad.xyz            (testnet MON)",
        "    2. cd contracts && cp .env.example .env                  then set DEPLOYER_PRIVATE_KEY=0x…",
        "         (MONAD_DEPLOYER_KEY is accepted as an alias)",
        "    3. make deploy-monad                                     writes deployments/10143.json",
        "",
        f"  Then re-run this check:  make verify-monad        explorer: {explorer}",
        "  No key handy?  make deploy-dry-run   proves the wiring locally, spends nothing.",
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--chain", type=int, default=int(os.environ.get("AVAIRA_CHAIN_ID", DEFAULT_CHAIN_ID)))
    ap.add_argument("--rpc", default=None, help="override the RPC endpoint")
    ap.add_argument("--manifest", default=None, help="override the manifest path")
    ap.add_argument("--json", metavar="PATH", help="write the report as JSON")
    args = ap.parse_args(argv)

    manifest_path = Path(args.manifest) if args.manifest else ROOT / "deployments" / f"{args.chain}.json"
    rpc_url = args.rpc or os.environ.get(RPC_ENV_BY_CHAIN.get(args.chain, ""), "") or RPC_BY_CHAIN.get(args.chain)
    if not rpc_url:
        print(f"  ✗ no RPC endpoint known for chain {args.chain} — pass --rpc", file=sys.stderr)
        return 1

    if not manifest_path.exists():
        print(f"  ✗ NOT DEPLOYED — {manifest_path.relative_to(ROOT) if manifest_path.is_relative_to(ROOT) else manifest_path}")
        for line in instruction(args.chain):
            print(f"    {line}" if line else "")
        if args.json:
            _write(args.json, {"chainId": args.chain, "verdict": "not-deployed", "manifest": None, "contracts": []})
        return 1

    manifest = json.loads(manifest_path.read_text())
    rpc = Rpc(rpc_url)

    try:
        on_chain_id = decode_word(rpc.call("eth_chainId", []))
    except RpcError as exc:
        print(f"  ✗ UNREACHABLE — {exc}")
        print(f"    The manifest exists, so this is a network problem, not a deployment problem.")
        print(f"    Endpoint: {rpc_url}")
        if args.json:
            _write(args.json, {"chainId": args.chain, "verdict": "unreachable", "error": str(exc), "contracts": []})
        return 1

    if on_chain_id != args.chain:
        print(f"  ✗ WRONG CHAIN — {rpc_url} reports chain {on_chain_id}, manifest is for {args.chain}")
        print("    Point --rpc at the right network; addresses from another chain prove nothing.")
        if args.json:
            _write(args.json, {"chainId": args.chain, "verdict": "wrong-chain", "rpcChainId": on_chain_id, "contracts": []})
        return 1

    findings: list[Finding] = []
    for name, address, getters in build_checks(manifest):
        findings.append(check_contract(rpc, name, address, getters, manifest))

    width = max(len(f.contract) for f in findings)
    for f in findings:
        mark = "PASS" if f.ok else "FAIL"
        size = "—" if f.code_bytes is None else f"{f.code_bytes}B"
        print(f"  {mark}  {f.contract.ljust(width)}  {f.address}  {size}, {len(f.answered)} getters")
        for p in f.problems:
            print(f"        ! {p}")

    failed = [f for f in findings if not f.ok]
    explorer = EXPLORER_BY_CHAIN.get(args.chain, "")
    print()
    if failed:
        print(f"  ✗ {len(failed)} of {len(findings)} contracts are not verifiably live on chain {args.chain}")
        print(f"    Explorer: {explorer}")
    else:
        print(f"  ✓ all {len(findings)} contracts live and correctly wired on chain {args.chain}")
        print(f"    Explorer: {explorer}/address/{manifest.get('identityRegistry', '')}")

    _write(
        args.json,
        {
            "chainId": args.chain,
            "rpc": rpc_url,
            "manifest": manifest,
            "verdict": "PASS" if not failed else "FAIL",
            "contracts": [
                {"name": f.contract, "address": f.address, "codeBytes": f.code_bytes, "getters": f.answered, "problems": f.problems}
                for f in findings
            ],
        },
    )
    return 1 if failed else 0


def _write(path: str | None, report: dict) -> None:
    if not path:
        return
    out = Path(path)
    if not out.is_absolute():
        out = ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
