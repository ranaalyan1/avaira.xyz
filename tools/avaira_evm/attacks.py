"""Team RED: named attack scenarios against the real Avaira bytecode.

Every finding in `FINDINGS.md` has an id (`AV-nnn`) and a PoC with the same id in this file.
The PoCs talk to the compiled contracts through the same in-process EVM as the invariant
campaign, so an "exploited" verdict is not prose — it is a transaction that landed, with the
state change printed next to it.

    python3 tools/avaira_evm/attacks.py                 # run everything
    python3 tools/avaira_evm/attacks.py --id AV-003     # run one
    python3 tools/avaira_evm/attacks.py --json verification/reports/redteam.json

Each scenario declares the outcome it expects:

* `BLOCKED` for a finding that is **fixed** — the protocol must refuse the attack forever;
* `EXPLOIT-CONFIRMED` for a finding that is **documented and accepted** (a design trade-off
  recorded in the risk register, or an inherent property of the model).

Exit code is 0 only when every scenario matches its declared expectation, so this file is both
the evidence appendix of `FINDINGS.md` and a permanent tripwire: change the behaviour of the
protocol — in either direction — without changing the documentation that describes it, and CI
goes red.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))

from avaira_evm.harness import AvairaChain  # noqa: E402

USDC = 10**6
INTENT = bytes.fromhex("11" * 32)


@dataclass
class Scenario:
    id: str
    title: str
    severity: str
    expect: str  # EXPLOIT-CONFIRMED | BLOCKED
    notes: str = ""
    evidence: dict = field(default_factory=dict)
    outcome: str = ""

    @property
    def verdict(self) -> str:
        return "MATCH" if self.outcome == self.expect else "MISMATCH"


class Red:
    def __init__(self, chain: AvairaChain):
        self.chain = chain
        self.scenarios: dict[str, Scenario] = {}

    # ------------------------------------------------------------------ helpers
    def agent(self, i: int) -> tuple[int, str]:
        """Register an agent owned by `accounts[i]` and stake the minimum. Returns (id, owner)."""
        c = self.chain
        owner = c.accounts[i]
        bond = c.call("AvairaIdentityRegistry", "registrationBond()")
        res = c.transact("AvairaIdentityRegistry", "register(string)", [f"ipfs://red{i}"], owner, value=bond)
        agent_id = c.call("AvairaIdentityRegistry", "nextAgentId()") - 1
        assert res.ok, res.error
        c.transact("MockUSDC", "approve(address,uint256)", [c.stake_addr, 10**12], owner)
        c.transact("MockUSDC", "approve(address,uint256)", [c.market_addr, 10**12], owner)
        staked = c.call("AvairaStakeRegistry", "minStake()")
        r2 = c.transact("AvairaStakeRegistry", "stake(uint256,uint256)", [agent_id, staked], owner)
        assert r2.ok, r2.error
        return agent_id, owner

    def leaf(self, agent_id: int, intent_hash: bytes, action: str, spend: int, nonce: int) -> bytes:
        from eth_abi import encode
        from eth_utils import keccak

        return keccak(
            encode(
                ["string", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
                [b"Avaira.DeviationLeaf.v1".decode(), agent_id, intent_hash, keccak(text=action), spend, nonce],
            )
        )

    @staticmethod
    def root(leaves: list[bytes]) -> bytes:
        from eth_utils import keccak

        lvl = [keccak(b"\x00" + l) for l in leaves]
        while len(lvl) > 1:
            lvl = [
                keccak(b"\x01" + min(lvl[i], lvl[i + 1]) + max(lvl[i], lvl[i + 1])) if i + 1 < len(lvl) else lvl[i]
                for i in range(0, len(lvl), 2)
            ]
        return lvl[0]

    def proof(self, leaves: list[bytes], index: int) -> list[bytes]:
        from eth_utils import keccak

        lvl = [keccak(b"\x00" + l) for l in leaves]
        out: list[bytes] = []
        pos = index
        while len(lvl) > 1:
            sib = pos ^ 1
            if sib < len(lvl):
                out.append(lvl[sib])
            lvl = [
                keccak(b"\x01" + min(lvl[i], lvl[i + 1]) + max(lvl[i], lvl[i + 1])) if i + 1 < len(lvl) else lvl[i]
                for i in range(0, len(lvl), 2)
            ]
            pos //= 2
        return out

    # ------------------------------------------------------------------ scenarios
    def av_001(self) -> Scenario:
        """`getSummary` scales every record to the widest `valueDecimals` before averaging, inside
        int256. An int128-magnitude record posted next to an 18-decimal record overflows the sum and
        the read path reverts forever. Feedback rows are append-only: only their author can revoke
        one, so the victim of this grief cannot undo it."""
        s = Scenario("AV-001", "Reputation read-path DoS: int256 overflow in getSummary", "high", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        # Two reviewers, each with their own agent + minimum stake (the grounding requirement).
        reviewers = []
        for i in (4, 5):
            who = c.accounts[i]
            rid, _ = self.agent(i)
            reviewers.append((who, rid))
        reviewer_a, reviewer_b = (r[0] for r in reviewers)
        INT128_MAX = 2**127 - 1
        r1 = c.transact(
            "AvairaReputationRegistry",
            "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
            [agent_id, INT128_MAX, 0, "successRate", "", "", "", b"\x01" * 32],
            reviewer_a,
        )
        r2 = c.transact(
            "AvairaReputationRegistry",
            "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
            [agent_id, 1, 18, "successRate", "", "", "", b"\x02" * 32],
            reviewer_b,
        )
        ok, detail = c.try_call(
            "AvairaReputationRegistry", "getSummary(uint256,address[],string)", [agent_id, [reviewer_a, reviewer_b], "successRate"]
        )
        # The honest escape hatch: can the *author* revoke their way out?
        revoked = c.transact("AvairaReputationRegistry", "revokeFeedback(uint256,uint64)", [agent_id, 0], reviewer_a)
        ok_after, detail_after = c.try_call(
            "AvairaReputationRegistry", "getSummary(uint256,address[],string)", [agent_id, [reviewer_a, reviewer_b], "successRate"]
        )
        s.evidence = {
            "extremeRecordAccepted": r1.ok,
            "wideDecimalsRecordAccepted": r2.ok,
            "getSummaryOk": ok,
            "getSummaryDetail": detail if not ok else "ok",
            "costToGrieve": "minStake (100 USDC) + one feedback call",
            "authorCanRevoke": revoked.ok,
            "getSummaryOkAfterAuthorRevokes": ok_after,
            "detailAfterRevoke": detail_after if not ok_after else "ok",
        }
        s.outcome = "BLOCKED" if (not r1.ok or (ok and ok_after)) else "EXPLOIT-CONFIRMED"
        if not r1.ok:
            s.evidence["guard"] = r1.error
        return s

    def av_002(self) -> Scenario:
        """No unbonding delay: the staker can pull capital between attestation and challenge, so
        a proven deviation slashes nothing."""
        s = Scenario("AV-002", "Slash escape: unstake inside the challenge window", "high", "EXPLOIT-CONFIRMED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        envelope = [100 * USDC, ["email.send"], c.now() + 3600]
        c.transact("AvairaIntentVault", "commitIntent(uint256,bytes32,(uint256,string[],uint64))", [agent_id, INTENT, envelope], owner)
        leaves = [self.leaf(agent_id, INTENT, "email.send", 999 * USDC, 0)]
        c.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, INTENT, self.root(leaves), self.root(leaves)], owner)
        before = c.call("AvairaStakeRegistry", "stakeOf(uint256)", [agent_id])
        # Walk away from the stake while the window is still open.
        c.transact("AvairaStakeRegistry", "unstake(uint256,uint256)", [agent_id, before], owner)
        challenger = c.accounts[6]
        c.transact("MockUSDC", "approve(address,uint256)", [c.vault_addr, 10**9], challenger)
        r = c.transact(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, INTENT, [agent_id, INTENT, "email.send", 999 * USDC, 0], self.proof(leaves, 0)],
            challenger,
        )
        s.evidence = {
            "stakeBeforeExit": before,
            "challengeOk": r.ok,
            "slashedTo": c.call("AvairaStakeRegistry", "stakeOf(uint256)", [agent_id]),
            "statusAfter": c.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id]),
            "unstakeDelaySeconds": c.call("AvairaStakeRegistry", "suspensionCooldown()"),
        }
        s.outcome = "EXPLOIT-CONFIRMED" if r.ok else "BLOCKED"
        return s

    def av_003(self) -> Scenario:
        """`overSpend` is guarded by `maxSpendUsd > 0`, so committing a zero cap means "unlimited":
        an agent can set 0 and never be slashable for overspend."""
        s = Scenario("AV-003", "Envelope with maxSpendUsd == 0 disables overspend detection", "medium", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        zero_cap = [0, ["email.send"], c.now() + 3600]
        c.transact("AvairaIntentVault", "commitIntent(uint256,bytes32,(uint256,string[],uint64))", [agent_id, INTENT, zero_cap], owner)
        # A $1,000,000 spend against a $0 cap, inside the allow-list.
        leaves = [self.leaf(agent_id, INTENT, "email.send", 10**6 * USDC, 0)]
        rt = self.root(leaves)
        c.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, INTENT, rt, rt], owner)
        challenger = c.accounts[6]
        c.transact("MockUSDC", "approve(address,uint256)", [c.vault_addr, 10**9], challenger)
        r = c.transact(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, INTENT, [agent_id, INTENT, "email.send", 10**6 * USDC, 0], self.proof(leaves, 0)],
            challenger,
        )
        status = c.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id])
        staked_left = c.call("AvairaStakeRegistry", "stakeOf(uint256)", [agent_id])
        s.evidence = {
            "committedMaxSpendUsd": 0,
            "leafSpendUsd": 10**6 * USDC,
            "challengeAccepted": r.ok,
            "revert": r.error if not r.ok else "",
            "agentStatusAfter": status,
            "stakeAfter": staked_left,
            "expected": "a zero cap must mean 'spend nothing', so the deviation is provable and slashes",
        }
        # Fixed = the deviation against a $0 cap is provable and actually bites (SUSPENDED = 3).
        s.outcome = "BLOCKED" if (r.ok and status == 3 and staked_left < 100 * USDC) else "EXPLOIT-CONFIRMED"
        return s

    def av_004(self) -> Scenario:
        """`attestOutcome` accepts any root, including one that commits to nothing. A root the
        agent made up (or zero) makes every honest challenge fail — and costs the challenger a bond."""
        # NOT fixed in code (see FINDINGS.md AV-004 and SCOPE_PROPOSALS.md SP-02): `attestOutcome`
        # deliberately accepts any root, and three vault unit tests rely on that. The scenario
        # therefore *expects* the exploit to keep working, so the suite goes red the moment anyone
        # changes the behaviour without updating the documentation with it.
        s = Scenario("AV-004", "Attest a root that omits the deviation; challenger forfeits its bond", "medium", "EXPLOIT-CONFIRMED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        c.transact(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, INTENT, [USDC, ["email.send"], c.now() + 3600]],
            owner,
        )
        treasury_before = c.token_balance(c.treasury)
        challenger = c.accounts[6]
        c.transact("MockUSDC", "approve(address,uint256)", [c.vault_addr, 10**9], challenger)
        challenger_before = c.token_balance(challenger)
        bogus = b"\xde\xad" + b"\x00" * 30
        c.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, INTENT, bogus, bogus], owner)
        r = c.transact(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, INTENT, [agent_id, INTENT, "email.send", 500 * USDC, 0], []],
            challenger,
        )
        s.evidence = {
            "attestedZeroRoot": bogus.hex(),
            "challengeOk": r.ok,
            "challengerBondLost": challenger_before - c.token_balance(challenger),
            "treasuryGained": c.token_balance(c.treasury) - treasury_before,
        }
        s.outcome = "BLOCKED" if not r.ok else "EXPLOIT-CONFIRMED"
        return s

    def av_005(self) -> Scenario:
        """First-upheld-challenge-wins with a 50% bounty: a watcher who copies the whistleblower's
        leaf and outbids it takes the bounty; the whistleblower gets nothing and the intent is spent."""
        s = Scenario("AV-005", "Bounty race: copied challenge beats the original reporter", "medium", "EXPLOIT-CONFIRMED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        c.transact(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, INTENT, [USDC, ["email.send"], c.now() + 3600]],
            owner,
        )
        leaves = [self.leaf(agent_id, INTENT, "email.send", 500 * USDC, 0)]
        rt = self.root(leaves)
        c.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, INTENT, rt, rt], owner)
        honest, sniper = c.accounts[7], c.accounts[8]
        for who in (honest, sniper):
            c.transact("MockUSDC", "approve(address,uint256)", [c.vault_addr, 10**9], who)
        args = [agent_id, INTENT, [agent_id, INTENT, "email.send", 500 * USDC, 0], self.proof(leaves, 0)]
        r_sniper = c.transact("AvairaIntentVault", "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])", args, sniper)
        r_honest = c.transact("AvairaIntentVault", "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])", args, honest)
        s.evidence = {
            "sniperBounty": c.token_balance(sniper),
            "honestReward": c.token_balance(honest),
            "secondChallengeReverted": not r_honest.ok,
            "secondChallengeError": r_honest.error,
            "oneSlashPerIntent": True,
        }
        s.outcome = "EXPLOIT-CONFIRMED" if r_sniper.ok and not r_honest.ok else "BLOCKED"
        return s

    def av_006(self) -> Scenario:
        """`borrowCapacity` floors `collateral·BPS/ratio`; `borrow` floors the inverse
        `newDebt·ratio/BPS`. If the two ever disagree, the market advertises capacity an honest
        agent cannot draw — a broken promise in the API the credit market is *for*."""
        s = Scenario("AV-006", "Credit market: borrowCapacity vs borrow rounding disagreement", "low", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 100], c.admin)  # tier A -> 110%
        disagreements = []
        # A spread of awkward collateral values, including ones just below a ratio boundary.
        for collateral in [1, 2, 3, 7, 909_091, 1_000_001, 10**6 + 1, 11 * 10**5 - 1, 12_500_001, 15 * 10**6 + 7, 10**9 + 3]:
            snap = c.snapshot()
            c.transact("AvairaCreditMarket", "depositCollateral(uint256,uint256)", [agent_id, collateral], owner)
            capacity = c.call("AvairaCreditMarket", "borrowCapacity(uint256)", [agent_id])
            if capacity:
                r = c.transact("AvairaCreditMarket", "borrow(uint256,uint256)", [agent_id, capacity], owner)
                if not r.ok:
                    disagreements.append({"collateral": collateral, "capacity": capacity, "revert": r.error})
            c.revert(snap)
        s.evidence = {"probedValues": 11, "disagreementCount": len(disagreements), "examples": disagreements[:4]}
        s.outcome = "BLOCKED" if not disagreements else "EXPLOIT-CONFIRMED"
        return s

    def av_007(self) -> Scenario:
        """`challengeEndsAt = uint64(now) + challengeWindow` overflows for a large admin-set window,
        which reverts *every* `attestOutcome` — a one-transaction, protocol-wide kill switch."""
        s = Scenario("AV-007", "setChallengeWindow(uin64 max) bricks attestOutcome for everyone", "medium", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        r_admin = c.transact("AvairaIntentVault", "setChallengeWindow(uint64)", [2**64 - 1], c.admin)
        c.transact(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, INTENT, [USDC, ["email.send"], c.now() + 3600]],
            owner,
        )
        r_attest = c.transact("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, INTENT, b"\x11" * 32, b"\x22" * 32], owner)
        s.evidence = {"hugeWindowAccepted": r_admin.ok, "attestOutcomeAfter": "ok" if r_attest.ok else r_attest.error}
        s.outcome = "BLOCKED" if (not r_admin.ok or r_attest.ok) else "EXPLOIT-CONFIRMED"
        if not r_admin.ok:
            s.evidence["guard"] = r_admin.error
        return s

    def av_008(self) -> Scenario:
        """EIP-3009 authorisations must be single-use. If a settled authorisation could be
        replayed, `giveFeedbackWithPayment`'s whole anti-Sybil story collapses: one real payment
        would buy an unbounded number of 'grounded' reviews."""
        s = Scenario("AV-008", "Replay of a settled EIP-3009 authorisation", "high", "BLOCKED")
        c = self.chain
        tok = c.deployed["MockUSDC"].w3c
        payer, payee = c.accounts[2], c.accounts[3]
        nonce = b"\x07" * 32
        value = 10**6
        lo, hi = c.now() - 100, c.now() + 36_000
        from eth_abi import encode as abi_encode
        from eth_utils import keccak

        def as_bytes(v) -> bytes:
            return bytes.fromhex(v[2:]) if isinstance(v, str) else bytes(v)

        domain = as_bytes(tok.functions.DOMAIN_SEPARATOR().call())
        typehash = as_bytes(tok.functions.TRANSFER_WITH_AUTHORIZATION_TYPEHASH().call())
        struct = abi_encode(
            ["bytes32", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
            [typehash, payer, payee, value, lo, hi, nonce],
        )
        digest = keccak(b"\x19\x01" + domain + keccak(struct))
        raw = c.key_for(payer).sign_msg_hash(digest)
        # OpenZeppelin 5.x ECDSA only accepts recovery ids 27/28, so normalise eth_keys' 0/1.
        sig = raw.r.to_bytes(32, "big") + raw.s.to_bytes(32, "big") + bytes([27 + raw.v])
        call = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"
        first = c.transact("MockUSDC", call, [payer, payee, value, lo, hi, nonce, sig], payee)
        second = c.transact("MockUSDC", call, [payer, payee, value, lo, hi, nonce, sig], payee)
        s.evidence = {
            "firstOk": first.ok,
            "replayOk": second.ok,
            "replayGuard": second.error,
            "payeeReceived": value if first.ok else 0,
        }
        s.outcome = "BLOCKED" if (first.ok and not second.ok) else "EXPLOIT-CONFIRMED"
        return s

    def av_009(self) -> Scenario:
        """On-chain grade bands vs the scorer service's bands must agree, or the same agent has two
        different grades depending on which product surface you read."""
        s = Scenario("AV-009", "Grade bands disagree between the chain and the scorer service", "medium", "BLOCKED")
        ts_src = os.path.join(REPO_ROOT, "services", "scorer", "src", "formula.ts")
        # The scorer's table is parsed out of its own source, so this scenario compares the two
        # shipped implementations instead of comparing the chain against a copy in this file.
        import re

        source = open(ts_src).read()
        body = source[source.index("const GRADE_BANDS") :]
        bands = [(int(m.group(1)), m.group(2)) for m in re.finditer(r'\{\s*min:\s*(\d+),\s*grade:\s*"([^"]+)"\s*\}', body)]
        fallback = re.search(r'return "([^"]+)";\n\}', body.split("\n\n")[0])
        bands.append((0, fallback.group(1) if fallback else "D"))

        def scorer_grade(score: int) -> str:
            for lo, name in bands:
                if score >= lo:
                    return name
            return "D"

        mismatches = []
        for score in range(0, 101):
            ok, chain_grade = self.chain.try_call("AvairaReputationRegistry", "gradeOfScore(uint8)", [score])
            if not ok:
                mismatches.append({"score": score, "error": chain_grade})
            elif chain_grade != scorer_grade(score):
                mismatches.append({"score": score, "chain": chain_grade, "scorer": scorer_grade(score)})
        s.evidence = {
            "scorerSource": os.path.relpath(ts_src, REPO_ROOT),
            "comparedScores": 101,
            "mismatchCount": len(mismatches),
            "examples": mismatches[:6],
        }
        s.outcome = "BLOCKED" if not mismatches else "EXPLOIT-CONFIRMED"
        return s

    def av_010(self) -> Scenario:
        """A BAN propagates to the identity registry through a low-level `call` whose failure is
        discarded. If `setEnforcer` was skipped at deploy time, the agent is BANNED for the gate but
        still ACTIVE everywhere the identity registry is the source of truth (the credit market)."""
        s = Scenario("AV-010", "Slashed BAN can fail to propagate to identity, silently", "medium", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        # Detach the enforcer to model a deployment that forgot `setEnforcer` (the wiring is one
        # `onlyOwner` call away in both directions, so this is a realistic operator mistake).
        c.transact("AvairaIdentityRegistry", "setEnforcer(address)", ["0x" + "00" * 20], c.admin)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        r = c.transact("AvairaStakeRegistry", "setSlasher(address,bool)", [c.admin, True], c.admin)
        assert r.ok, r.error
        slash = c.transact(
            "AvairaStakeRegistry",
            "slashAgent(uint256,uint8,address,bytes32,string)",
            [agent_id, 3, c.accounts[9], b"\xaa" * 32, "red-team: BAN propagation"],
            c.admin,
        )
        staked_status = c.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id])
        identity_banned = c.call("AvairaIdentityRegistry", "isBanned(uint256)", [agent_id])
        # The agent must still own a wallet binding and read as active: that is what a consumer of
        # the identity registry (credit market, x402 sellers, ERC-8004 crawlers) will see.
        c.transact("AvairaIdentityRegistry", "setAgentWallet(uint256,address,uint256,bytes)", [agent_id, c.accounts[5], c.now() + 3600, b""], owner) if False else None
        identity_active = c.call("AvairaIdentityRegistry", "isActive(uint256)", [agent_id])
        wallet_bound = c.call("AvairaIdentityRegistry", "getAgentWallet(uint256)", [agent_id])
        token_owner = c.call("AvairaIdentityRegistry", "ownerOf(uint256)", [agent_id])
        from eth_utils import keccak

        topic = keccak(text="BanPropagationFailed(uint256,address)").hex()
        emitted = any(topic in ("0x" + t.hex() if isinstance(t, bytes) else str(t)) for log in slash.logs for t in [log["topics"][0]])
        s.evidence = {
            "slashOk": slash.ok,
            "stakeRegistryStatus": staked_status,
            "identityRegistryBanned": identity_banned,
            "identityRegistryStillActive": identity_active,
            "identityStillOwnedBy": token_owner,
            "propagationFailureEmitted": emitted,
            "deployTimeGuard": "require(enforcer == stakeRegistry) in script/Deploy.s.sol",
            "harnessGuard": "AvairaChain.deploy_stack refuses to boot without the wiring",
            "residual": "a registry that refuses banAgent still cannot block the slash by design",
        }
        # Fixed = the divergence can no longer happen silently. The economics are unchanged
        # deliberately; see FINDINGS.md AV-010 and RISK_REGISTER R-06.
        s.outcome = "BLOCKED" if (staked_status != 4 or identity_banned or emitted) else "EXPLOIT-CONFIRMED"
        return s

    def av_011(self) -> Scenario:
        """`setAgentWallet` burns the nonce before verifying the signature, so any approved operator
        can invalidate a wallet-signed authorisation that is still in flight."""
        s = Scenario(
            "AV-011",
            "Failed setAgentWallet burns the nonce and voids an in-flight signature (refuted)",
            "info",
            "BLOCKED",
        )
        c = self.chain
        agent_id, owner = self.agent(2)
        wallet = c.accounts[4]
        nonce_before = c.call("AvairaIdentityRegistry", "agentWalletNonce(uint256)", [agent_id])
        # An operator (or anyone the owner approved) fires a garbage signature; it must revert.
        c.transact("AvairaIdentityRegistry", "approve(address,uint256)", [owner, agent_id], owner)
        junk = c.transact(
            "AvairaIdentityRegistry",
            "setAgentWallet(uint256,address,uint256,bytes)",
            [agent_id, wallet, c.now() + 3600, b"\x11" * 65],
            owner,
        )
        nonce_after = c.call("AvairaIdentityRegistry", "agentWalletNonce(uint256)", [agent_id])
        s.evidence = {
            "junkCallReverted": not junk.ok,
            "nonceBefore": nonce_before,
            "nonceAfter": nonce_after,
            "nonceBurned": nonce_after - nonce_before,
        }
        # A reverting call leaves no state behind, so the pre-increment never lands. Documented as
        # *considered and refuted* so the reasoning is not lost.
        s.evidence["why"] = "the ++ is rolled back with the rest of the reverted transaction"
        s.outcome = "BLOCKED" if (not junk.ok and nonce_after == nonce_before) else "EXPLOIT-CONFIRMED"
        return s

    def av_012(self) -> Scenario:
        """Cross-contract: a suspended agent must not be able to re-enter via re-collateralising
        before its cooldown has elapsed (the `stake()` reactivation shortcut)."""
        s = Scenario("AV-012", "Suspension cooldown bypass through `stake`", "high", "BLOCKED")
        c = self.chain
        agent_id, owner = self.agent(2)
        c.transact("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, 90], c.admin)
        r = c.transact("AvairaStakeRegistry", "setSlasher(address,bool)", [c.admin, True], c.admin)
        assert r.ok
        c.transact("AvairaStakeRegistry", "slashAgent(uint256,uint8,address,bytes32,string)", [agent_id, 2, c.accounts[9], b"\xaa" * 32, "suspension"], c.admin)
        status_mid = c.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id])
        c.transact("MockUSDC", "approve(address,uint256)", [c.stake_addr, 10**12], owner)
        bypass = c.transact("AvairaStakeRegistry", "stake(uint256,uint256)", [agent_id, 10**6], owner)
        status_after = c.call("AvairaStakeRegistry", "statusOf(uint256)", [agent_id])
        s.evidence = {
            "statusAfterSuspensionSlash": status_mid,
            "reStakeOk": bypass.ok,
            "statusAfterReStake": status_after,
            "expected": "3 (SUSPENDED) until the cooldown elapses",
            "cooldown": c.call("AvairaStakeRegistry", "suspensionCooldown()"),
        }
        s.outcome = "BLOCKED" if status_after == 3 else "EXPLOIT-CONFIRMED"
        return s


ALL = [
    "av_001",
    "av_002",
    "av_003",
    "av_004",
    "av_005",
    "av_006",
    "av_007",
    "av_008",
    "av_009",
    "av_010",
    "av_011",
    "av_012",
]


def scenario_id(name: str) -> str:
    return "AV-" + name.split("_")[1]


def run(ids: list[str] | None = None) -> tuple[list[Scenario], dict]:
    wanted = {i.upper() for i in (ids or [])}
    results: list[Scenario] = []
    for name in ALL:
        if wanted and scenario_id(name) not in wanted:
            continue
        chain = AvairaChain.spawn()
        chain.explain_reverts = True
        red = Red(chain)
        results.append(getattr(red, name)())
    build = {}
    try:
        with open(os.path.join(REPO_ROOT, "build", "avaira", "build-manifest.json")) as fh:
            build = json.load(fh)
    except Exception:  # noqa: BLE001
        pass
    meta = {
        "schema": "avaira.redteam/v1",
        "build": {
            "compiler": build.get("compiler"),
            "viaIR": (build.get("profiles") or {}).get("viaIR"),
            "sourceDigest": __import__("avaira_evm.campaign", fromlist=["sha256_of_build"]).sha256_of_build(),
        },
        "scenarios": [
            {
                "id": s.id,
                "title": s.title,
                "severity": s.severity,
                "expected": s.expect,
                "outcome": s.outcome,
                "verdict": s.verdict,
                "evidence": s.evidence,
            }
            for s in results
        ],
        "mismatches": [s.id for s in results if s.verdict == "MISMATCH"],
    }
    return results, meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--id", action="append", help="run only these scenario ids (e.g. --id AV-003)")
    ap.add_argument("--json", help="write the machine-readable report here")
    args = ap.parse_args(argv)

    results, meta = run(args.id)
    width = max(len(s.id) for s in results)
    print("Avaira RED team — attack scenarios against compiled bytecode\n")
    for s in results:
        mark = "✓" if s.verdict == "MATCH" else "✗"
        print(f"  {mark} {s.id:<{width}}  {s.outcome:<18} (expect {s.expect:<18}) {s.title}")
    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w") as fh:
            json.dump(meta, fh, indent=2, sort_keys=True)
            fh.write("\n")
    bad = meta["mismatches"]
    print(f"\n{len(results) - len(bad)}/{len(results)} scenarios match their declared expectation")
    if bad:
        print(f"MISMATCH: {', '.join(bad)}  — behaviour changed; update FINDINGS.md and this suite together.")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
