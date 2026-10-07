#!/usr/bin/env python3
"""`make demo` — one full Proof-of-Intent lifecycle, end to end, on a real EVM, deterministically.

Not a mock and not a recording: this boots py-evm, deploys the contracts compiled into
`build/avaira/artifacts.json`, and walks the exact sequence an integrator has — commit a plan,
execute inside the envelope, attest the outcome, get caught deviating, get slashed, and be refused
by the gate afterwards.

Determinism is the reason it is in CI: fixed agents, fixed amounts, no clock, no RNG, no network,
no faucet. `--check` diffs stdout against `tools/demo-expect.txt`, so a change in protocol
behaviour shows up as a reviewable diff instead of a silent doc drift.

    python3 tools/demo.py                 # narrative
    python3 tools/demo.py --json          # machine-readable trace
    python3 tools/demo.py --check         # CI: stdout must equal tools/demo-expect.txt
    python3 tools/demo.py --write-expect  # re-baseline (only when the behaviour change is intended)
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, REPO_ROOT)

from avaira_evm.harness import AvairaChain  # noqa: E402

USDC = 10**6
#: 2033-05-18, deliberately absolute. eth-tester starts its clock at wall-clock time, so a
#: relative deadline (`now() + 3600`) would shift `envelopeHash` — and therefore `intentHash` —
#: on every run, which is exactly what kills a byte-stable demo trace. Pinned means reproducible
#: until May 2033, at which point the gate step *should* start failing and CI says so out loud.
DEMO_DEADLINE = 2_000_000_000
EXPECT = os.path.join(HERE, "demo-expect.txt")
PLAN = {"id": "task-demo-1", "steps": ["web.search", "swap.execute"], "budget": {"unit": "usd", "max": 25}}


def canonical_plan_json(plan: dict) -> str:
    """The Python side of INV-CANON-01: sorted keys, compact separators, no whitespace.

    `tools/parity/compare.py` proves the TypeScript SDK and the on-chain libraries agree with this
    byte for byte; here we only need the same *function* the SDK runs, to show where `intentHash`
    comes from instead of pasting a magic constant.
    """
    return json.dumps(plan, sort_keys=True, separators=(",", ":"))


class Demo:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.facts: dict[str, object] = {}

    def say(self, text: str = "") -> None:
        self.lines.append(text)
        print(text)

    def step(self, label: str, detail: str) -> None:
        self.say(f"  {label:<24} {detail}")

    def usdc(self, units: int) -> str:
        return f"{units} USDC"

    # ------------------------------------------------------------------ run
    def run(self) -> dict:
        from eth_abi import encode as abi_encode
        from eth_utils import keccak

        chain = AvairaChain.spawn()
        owner, challenger, admin = chain.accounts[2], chain.accounts[6], chain.admin
        facts = self.facts

        self.say("avaira proof-of-intent — one lifecycle, one local chain")
        self.say("")

        # ── 1. an agent with skin in the game
        self.say("[join]")
        bond = chain.call("AvairaIdentityRegistry", "registrationBond()")
        chain.transact("AvairaIdentityRegistry", "register(string)", ["ipfs://demo"], owner, value=bond)
        agent_id = chain.call("AvairaIdentityRegistry", "nextAgentId()") - 1
        min_stake = chain.call("AvairaStakeRegistry", "minStake()")
        chain.transact("MockUSDC", "approve(address,uint256)", [chain.stake_addr, 10**12], owner)
        chain.transact("AvairaStakeRegistry", "stake(uint256,uint256)", [agent_id, min_stake], owner)
        chain.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 82], admin)
        grade = chain.call("AvairaReputationRegistry", "gradeOfScore(uint8)", [82])
        self.step("identity", f"agent #{agent_id} minted (bond {bond / 1e18:g} MON), owner {owner[:10]}…")
        self.step("stake", f"{self.usdc(min_stake // USDC)} locked — the protocol minimum")
        self.step("reputation", f"score 82 → grade {grade!r} from the on-chain band table")
        facts["agentId"] = agent_id
        facts["minStakeUSDC"] = min_stake // USDC
        facts["grade82"] = grade

        allowed, _code, reason = chain.call("AvairaIntentVault", "checkGate(uint256)", [agent_id])[:3]
        self.step("gate", f"allowed={allowed} reason={reason}")
        facts["gateBefore"] = bool(allowed)

        # ── 2. commit *before* acting: the plan is hashed, not described
        self.say("")
        self.say("[commit]")
        plan_json = canonical_plan_json(PLAN)
        actions_hash = keccak(abi_encode(["string[]"], [PLAN["steps"]]))
        deadline = DEMO_DEADLINE
        envelope = [PLAN["budget"]["max"] * USDC, actions_hash, deadline]
        envelope_hash = keccak(abi_encode(["uint256", "bytes32", "uint64"], [envelope[0], envelope[1], envelope[2]]))
        intent_hash = keccak(
            abi_encode(
                ["string", "uint256", "string", "string", "bytes32", "uint256"],
                ["Avaira.Intent.v1", agent_id, PLAN["id"], plan_json, envelope_hash, 1],
            )
        )
        self.step("canonical plan", f"{len(plan_json)} bytes, keys sorted at every depth")
        self.step("envelopeHash", f"cap ${PLAN['budget']['max']}, 2 allowed actions, deadline {DEMO_DEADLINE} (pinned)")
        self.step("intentHash", f"0x{intent_hash.hex()[:32]}…")
        chain.transact("MockUSDC", "approve(address,uint256)", [chain.vault_addr, 10**12], owner)
        chain.transact(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, intent_hash, [PLAN["budget"]["max"] * USDC, list(PLAN["steps"]), deadline]],
            owner,
        )
        facts["intentHash"] = "0x" + intent_hash.hex()
        facts["envelopeHash"] = "0x" + envelope_hash.hex()

        # ── 3. execute honestly, then anchor the trail
        def leaf(action: str, spend: int, nonce: int, intent: bytes = intent_hash) -> bytes:
            return keccak(
                abi_encode(
                    ["string", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
                    ["Avaira.DeviationLeaf.v1", agent_id, intent, keccak(text=action), spend, nonce],
                )
            )

        def root(leaves: list[bytes]) -> bytes:
            level = [keccak(b"\x00" + l) for l in leaves]
            while len(level) > 1:
                level = [
                    keccak(b"\x01" + min(level[i], level[i + 1]) + max(level[i], level[i + 1]))
                    if i + 1 < len(level)
                    else level[i]
                    for i in range(0, len(level), 2)
                ]
            return level[0]

        def proof(leaves: list[bytes], index: int) -> list[bytes]:
            level = [keccak(b"\x00" + l) for l in leaves]
            out, pos = [], index
            while len(level) > 1:
                sib = pos ^ 1
                if sib < len(level):
                    out.append(level[sib])
                level = [
                    keccak(b"\x01" + min(level[i], level[i + 1]) + max(level[i], level[i + 1]))
                    if i + 1 < len(level)
                    else level[i]
                    for i in range(0, len(level), 2)
                ]
                pos //= 2
            return out

        honest = [leaf("web.search", 4 * USDC, 0), leaf("swap.execute", 9 * USDC, 1)]
        anchored = root(honest)
        chain.transact(
            "AvairaIntentVault",
            "attestOutcome(uint256,bytes32,bytes32,bytes32)",
            [agent_id, intent_hash, anchored, anchored],
            owner,
        )
        self.say("")
        self.say("[execute → attest]")
        self.step("actions", "web.search $4, swap.execute $9 — inside the $25 cap")
        self.step("root anchored", f"0x{anchored.hex()[:32]}…")
        facts["honestRoot"] = "0x" + anchored.hex()

        # ── 4a. a challenge only works against what was actually anchored
        chain.transact("MockUSDC", "approve(address,uint256)", [chain.vault_addr, 10**9], challenger)
        bogus_leaf = leaf("swap.execute", 90 * USDC, 2)
        re_attest = chain.transact(
            "AvairaIntentVault",
            "attestOutcome(uint256,bytes32,bytes32,bytes32)",
            [agent_id, intent_hash, root(honest + [bogus_leaf]), root(honest + [bogus_leaf])],
            owner,
        )
        self.say("")
        self.say("[deviation the anchor does not cover]")
        self.step("re-attest", f"accepted={re_attest.ok} {('— ' + re_attest.error) if not re_attest.ok else ''}")
        lost_before = chain.token_balance(challenger)
        first = chain.transact(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, intent_hash, [agent_id, intent_hash, "swap.execute", 90 * USDC, 2], proof(honest, 0)],
            challenger,
        )
        forfeit = (lost_before - chain.token_balance(challenger)) // USDC
        self.step("challenge", f"submitted (tx ok={first.ok}) — but the leaf is not in the anchored tree")
        self.step("cost", f"reporter forfeits {forfeit} USDC of bond for a claim it cannot prove")
        facts["reAttestError"] = re_attest.error if not re_attest.ok else ""
        facts["unsupportedChallengeOk"] = first.ok

        # ── 4b. the real breach: a second intent that *does* anchor an over-spend
        self.say("")
        self.say("[deviation the anchor does cover]")
        intent2 = keccak(
            abi_encode(
                ["string", "uint256", "string", "string", "bytes32", "uint256"],
                ["Avaira.Intent.v1", agent_id, "task-demo-2", canonical_plan_json(PLAN), envelope_hash, 2],
            )
        )
        chain.transact(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, intent2, [PLAN["budget"]["max"] * USDC, list(PLAN["steps"]), deadline]],
            owner,
        )
        breach = leaf("swap.execute", 90 * USDC, 0, intent2)
        anchored2 = root([leaf("web.search", 4 * USDC, 0, intent2), breach])
        chain.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, intent2, anchored2, anchored2], owner)
        self.step("intent #2", "same $25 cap; the agent anchors a tree containing a $90 swap")
        treasury_before = chain.token_balance(chain.treasury)
        challenger_before = chain.token_balance(challenger)
        slashed_before = chain.call("AvairaStakeRegistry", "stakeOf(uint256)", [agent_id])
        res = chain.transact(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, intent2, [agent_id, intent2, "swap.execute", 90 * USDC, 0], proof([leaf("web.search", 4 * USDC, 0, intent2), breach], 1)],
            challenger,
        )
        slashed_after = chain.call("AvairaStakeRegistry", "stakeOf(uint256)", [agent_id])
        status = chain.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id])
        self.step("challenge", f"accepted={res.ok}" + ("" if res.ok else f" ({res.error})"))
        self.step("slash", f"{self.usdc(slashed_before // USDC)} → {self.usdc(slashed_after // USDC)}, status={status} (2 ACTIVE, 3 SUSPENDED)")
        self.step(
            "bounty",
            f"challenger +{(chain.token_balance(challenger) - challenger_before) // USDC}, "
            f"treasury +{(chain.token_balance(chain.treasury) - treasury_before) // USDC}",
        )
        facts.update(
            {
                "challengeAccepted": res.ok,
                "stakeBeforeSlashUSDC": slashed_before // USDC,
                "stakeAfterSlashUSDC": slashed_after // USDC,
                "statusAfter": status,
                "treasuryGainUSDC": (chain.token_balance(chain.treasury) - treasury_before) // USDC,
                "challengerGainUSDC": (chain.token_balance(challenger) - challenger_before) // USDC,
                "intent2": "0x" + intent2.hex(),
            }
        )

        # ── 5. the gate is the point
        allowed_after, _c2, reason_after = chain.call("AvairaIntentVault", "checkGate(uint256)", [agent_id])[:3]
        self.say("")
        self.say("[after]")
        self.step("gate", f"allowed={allowed_after} reason={reason_after}")
        self.step(
            "window",
            f"still open for challenges = {chain.call('AvairaIntentVault', 'isChallengeOpen(uint256,bytes32)', [agent_id, intent2])}",
        )
        facts["gateAfter"] = bool(allowed_after)

        verdict = "PASS" if (res.ok and not allowed_after and slashed_after < slashed_before and status == 3) else "FAIL"
        self.say("")
        self.say(
            "result: only an anchored deviation is slashable; when one was, half the stake moved, the"
            f" reporter was paid, and the pre-execution gate now refuses this agent (gate={allowed_after})."
        )
        facts["verdict"] = verdict
        facts["stdout"] = "\n".join(self.lines)
        return facts

    # ------------------------------------------------------------------ cli
    def main(self, argv: list[str]) -> int:
        ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
        ap.add_argument("--json", action="store_true", help="print the trace as JSON instead of narrating")
        ap.add_argument("--out", help="also write the JSON trace here")
        ap.add_argument("--check", action="store_true", help="assert stdout equals tools/demo-expect.txt")
        ap.add_argument("--write-expect", action="store_true", help="re-baseline tools/demo-expect.txt")
        ap.add_argument("--quiet", action="store_true")
        args = ap.parse_args(argv)

        import contextlib

        demo = Demo()
        if args.quiet or args.json or args.check or args.write_expect:
            with contextlib.redirect_stdout(__import__("io").StringIO()):
                facts = demo.run()
        else:
            facts = demo.run()

        text = str(facts["stdout"])
        if args.out:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            with open(args.out, "w") as fh:
                json.dump({k: v for k, v in facts.items() if k != "stdout"}, fh, indent=2, sort_keys=True)
                fh.write("\n")
        if args.json:
            print(json.dumps({k: v for k, v in facts.items() if k != "stdout"}, indent=2, sort_keys=True))
        elif args.check or args.write_expect:
            pass
        else:
            print("")  # trailing newline after the narrated run

        if args.write_expect:
            with open(EXPECT, "w") as fh:
                fh.write(text + "\n")
            print(f"wrote {os.path.relpath(EXPECT, REPO_ROOT)}")
        if args.check:
            if not os.path.exists(EXPECT):
                print("missing tools/demo-expect.txt — run `python3 tools/demo.py --write-expect`", file=sys.stderr)
                return 1
            want = open(EXPECT).read().rstrip("\n")
            if want != text.rstrip("\n"):
                print("demo output drifted from tools/demo-expect.txt:", file=sys.stderr)
                for i, (a, b) in enumerate(zip(want.split("\n"), text.split("\n"))):
                    if a != b:
                        print(f"  line {i + 1}\n    expected {a!r}\n    actual   {b!r}", file=sys.stderr)
                        break
                if len(want.split("\n")) != len(text.split("\n")):
                    print(f"  line count changed: {len(want.splitlines())} → {len(text.splitlines())}", file=sys.stderr)
                return 1
            print("demo trace is deterministic and matches tools/demo-expect.txt")

        return 0 if facts.get("verdict") == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(Demo().main(sys.argv[1:]))
