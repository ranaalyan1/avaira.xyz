#!/usr/bin/env python3
"""Deploy dry-run — prove `make deploy-robinhood` will wire correctly *before* funds move.

`make deploy-robinhood` broadcasts a real transaction with real MON. The one thing a
deployer wants to know beforehand is whether the six constructors and the
cross-contract wiring in `contracts/script/Deploy.s.sol` still agree with each
other — a mismatch there is discovered *after* paying gas, and the fix is another
deploy.

This runs the same deployment in an in-process py-evm chain: the identical
constructor arguments and the identical wiring calls, taken from
`contracts/script/Deploy.s.sol` (see `DEFAULTS` and `deploy_stack()` in
`tools/avaira_evm/harness.py`, which is the single implementation this and the
`make redteam|fuzz` harnesses both use). Then it asserts, for every contract:

  * the address actually has bytecode;
  * a cheap view getter answers (the contract is not a tombstone);
  * the getter points at the *expected* sibling, so "the right contract is at the
    right address" is checked, not just "something is deployed".

Exit 0 = the deploy path is sound. Non-zero = do not spend MON yet.

    python3 tools/deploy_dry_run.py
    python3 tools/deploy_dry_run.py --json build/avaira/deploy-dry-run.json

This is NOT a deployment and deliberately does not write `deployments/46630.json`
— the addresses are ephemeral and exist only inside this process. `make verify-robinhood`
checks the real chain.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, REPO_ROOT)

from avaira_evm.harness import DEFAULTS, AvairaChain  # noqa: E402

ZERO = "0x" + "0" * 40


@dataclass
class Finding:
    name: str
    address: str
    code_bytes: int
    getters: dict
    problems: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.code_bytes > 0 and not self.problems


def check(chain: AvairaChain, name: str, address: str, getters: dict, expect: dict) -> Finding:
    """Assert bytecode exists, every getter answers, and each one matches `expect`."""
    problems: list[str] = []
    code = chain.w3.eth.get_code(address)
    code_bytes = len(code)
    if code_bytes == 0:
        problems.append("no bytecode at the address")

    answered: dict = {}
    for signature, want in getters.items():
        try:
            got = chain.call(name, signature)
        except Exception as exc:  # noqa: BLE001 - a view that reverts is a finding, not a crash
            problems.append(f"{signature} reverted: {chain.deployed[name].decode(str(exc))}")
            continue
        if isinstance(got, bytes):
            got = "0x" + got.hex()
        answered[signature] = got
        if isinstance(want, str) and want.lower() != ZERO and str(got).lower() != want.lower():
            problems.append(f"{signature} = {got}, expected {want}")
        elif isinstance(want, int) and int(got) != want:
            problems.append(f"{signature} = {got}, expected {want}")
    return Finding(name, address, code_bytes, answered, problems)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", metavar="PATH", help="write a manifest-shaped record of the dry-run")
    ap.add_argument("--quiet", action="store_true", help="only print the verdict")
    args = ap.parse_args(argv)

    chain = AvairaChain.spawn(accounts=4)

    d = DEFAULTS
    identity, stake, vault = chain.identity_addr, chain.stake_addr, chain.vault_addr
    market, reputation, validation, usdc = (
        chain.market_addr,
        chain.reputation_addr,
        chain.validation_addr,
        chain.usdc_addr,
    )

    # Every expectation below is a wiring fact from Deploy.s.sol, so a drift between
    # the script and the contracts fails here instead of on testnet.
    findings = [
        check(chain, "MockUSDC", usdc, {"symbol()": "USDC", "decimals()": 6}, {}),
        check(
            chain,
            "AvairaIdentityRegistry",
            identity,
            {"enforcer()": stake, "registrationBond()": d["registration_bond"], "treasury()": chain.treasury},
            {},
        ),
        check(
            chain,
            "AvairaReputationRegistry",
            reputation,
            {
                "identityRegistry()": identity,
                "stakeRegistry()": stake,
                "settlementToken()": usdc,
                "minGroundedPayment()": d["min_grounded_payment"],
            },
            {},
        ),
        check(chain, "AvairaValidationRegistry", validation, {"identityRegistry()": identity}, {}),
        check(
            chain,
            "AvairaStakeRegistry",
            stake,
            {
                "identityRegistry()": identity,
                "stakeToken()": usdc,
                "minStake()": d["min_stake"],
                "minScore()": d["min_score"],
            },
            {},
        ),
        check(
            chain,
            "AvairaIntentVault",
            vault,
            {
                "identityRegistry()": identity,
                "stakeRegistry()": stake,
                "stakeToken()": usdc,
                "challengeWindow()": d["challenge_window"],
                "challengerBond()": d["challenger_bond"],
            },
            {},
        ),
        check(
            chain,
            "AvairaCreditMarket",
            market,
            {"identityRegistry()": identity, "stakeRegistry()": stake, "asset()": usdc, "totalLiquidity()": d["seed_liquidity"]},
            {},
        ),
    ]

    # AV-010: the identity registry must treat the stake registry as its enforcer, or
    # bans cannot propagate and every other check here is verifying the wrong protocol.
    if chain.call("AvairaIdentityRegistry", "enforcer()").lower() != stake.lower():
        findings.append(Finding("AV-010 enforcer", identity, 0, {}, ["enforcer is not the stake registry"]))

    if not args.quiet:
        print("── Avaira deploy dry-run (in-process py-evm) ──────────────")
        print(f"  deployer : {chain.deployer}")
        print(f"  chain id : {chain.w3.eth.chain_id} (local; production target is 46630)")
        print()
        width = max(len(f.name) for f in findings)
        for f in findings:
            mark = "PASS" if f.ok else "FAIL"
            print(f"  {mark}  {f.name.ljust(width)}  {f.address}  {f.code_bytes} bytes, {len(f.getters)} getters")
            for p in f.problems:
                print(f"        ! {p}")
        print()

    failed = [f for f in findings if not f.ok]
    if failed:
        print(f"  ✗ dry-run FAILED — {len(failed)} contract(s) would not deploy correctly.")
        print("    Fix contracts/script/Deploy.s.sol before spending MON.")
    else:
        print(f"  ✓ dry-run PASS — all {len(findings)} deployments and their wiring are correct.")
        print("    The same sequence is what `make deploy-robinhood` broadcasts.")

    if args.json:
        out = args.json if os.path.isabs(args.json) else os.path.join(REPO_ROOT, args.json)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        record = {
            "schema": "avaira.deploy-dry-run/v1",
            "mode": "in-process-py-evm",
            "note": (
                "Ephemeral local addresses — NOT a chain deployment. The real "
                "manifest is deployments/46630.json, written by make deploy-robinhood."
            ),
            "chainId": chain.w3.eth.chain_id,
            "deployer": chain.deployer,
            "contracts": {
                f.name: {"address": f.address, "codeBytes": f.code_bytes, "getters": f.getters, "problems": f.problems}
                for f in findings
            },
            "verdict": "PASS" if not failed else "FAIL",
        }
        with open(out, "w") as fh:
            json.dump(record, fh, indent=2)
            fh.write("\n")
        if not args.quiet:
            print(f"    record → {os.path.relpath(out, REPO_ROOT)}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
