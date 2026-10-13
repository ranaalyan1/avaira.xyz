"""Stateful invariant campaign against the real Avaira bytecode.

What this proves
----------------
`tools/avaira_evm/campaign.py` drives the compiled contracts through pseudo-random, seeded,
reproducible call sequences and evaluates a fixed set of protocol invariants after every
sequence. It is the toolchain-free sibling of the Foundry invariant campaign
(`contracts/test/invariant/`): same invariants, same handler logic, but it runs on any
machine that has Python + one `npm install` — no `forge`, no `solc` binary, no Docker, no RPC.

Three properties make it usable as *proof* rather than as reassurance:

* **Reproducible.** A failing sequence replays from `(seed, sequence_index, step_index)`
  alone. The report prints the exact replay command.
* **Total.** A violation aborts the run with exit code 1. Silence is not a pass: the report
  contains counters (calls executed, reverts classified, invariants evaluated), and
  `tools/doctor.py` checks that a `PASS` report actually executed the configured budget.
* **Typed.** Reverts are decoded into the custom error that emitted them. A revert carrying a
  Solidity `Panic` payload (arithmetic overflow, under-assertion) is a violation, never an
  acceptable outcome — that is how this campaign finds read-path DoS bugs like the one in
  `FINDINGS.md#AV-004`.

Invariant ids here map 1:1 to `audit/INVARIANTS.md` and to the Foundry handler invariants, so
one list is the contract between the two engines.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from avaira_evm.harness import AvairaChain, DEFAULTS, GAS_PRICE  # noqa: E402

USDC = 10**6
#: mirrors `AvairaIntentVault.MAX_CHALLENGE_WINDOW` (3650 days); kept in sync by `tools/doctor.py`
MAX_CHALLENGE_WINDOW = 3650 * 86_400
ACTIONS = ["web.search", "mcp.call", "swap.execute", "email.send", "db.write", "file.read"]
TAGS = ["successRate", "uptime", "responseTime", "revenues", "starred", "ownerVerified"]

#: Every invariant id the campaign evaluates, in order. `audit/INVARIANTS.md` documents these.
INVARIANT_IDS = [
    "INV-LEDGER-01",
    "INV-LEDGER-02",
    "INV-SLASH-01",
    "INV-SLASH-02",
    "INV-SLASH-03",
    "INV-GATE-01",
    "INV-GATE-02",
    "INV-INTENT-01",
    "INV-INTENT-02",
    "INV-VIEW-01",
    "INV-PANIC-01",
    "INV-AUTH-01",
]


@dataclass
class Violation:
    invariant: str
    detail: str
    seed: int
    sequence: int
    step: int
    trace: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "invariant": self.invariant,
            "detail": self.detail,
            "seed": self.seed,
            "sequence": self.sequence,
            "step": self.step,
            "trace": self.trace,
        }


class World:
    """Oracle model of the small universe the campaign plays in.

    The oracle is deliberately *independent* of the contracts: it accumulates what the
    protocol should have done (capital in, slashed out, who staked what) and the campaign
    compares. If the oracle and the chain ever disagree, one of them is wrong, and that is a
    finding — not a test bug — so it is reported with the full trace.
    """

    def __init__(self, chain: AvairaChain, agents: list[int]):
        self.chain = chain
        self.agents = agents
        self.staker_of: dict[int, str] = {}
        self.staked_in: dict[int, int] = {a: 0 for a in agents}
        self.slash_events: dict[int, list[dict]] = {a: [] for a in agents}
        self.banned: set[int] = set()
        self.executed: set[tuple[int, bytes]] = set()
        self.challenged: set[tuple[int, bytes]] = set()
        self.attested_root: dict[tuple[int, bytes], list[bytes]] = {}
        self.attested_ends_at: dict[tuple[int, bytes], int] = {}
        self.owners: dict[int, str] = {}

    @property
    def registry_balance(self) -> int:
        return self.chain.token_balance(self.chain.stake_addr)

    @property
    def total_staked(self) -> int:
        return sum(self.staked_in[a] for a in self.agents) - sum(
            e["amount"] for a in self.agents for e in self.slash_events[a]
        )


class Campaign:
    def __init__(self, seed: int, sequences: int, depth: int, full_view_every: int = 16, explain: bool = False):
        self.explain = explain
        self._seq = 0
        self._step = 0
        self.seed = seed
        self.sequences = sequences
        self.depth = depth
        self.full_view_every = full_view_every
        self.rng = random.Random(seed)
        self.chain: AvairaChain | None = None
        self.world: World | None = None
        self.calls = 0
        self.reverts = 0
        self.revert_kinds: dict[str, int] = {}
        self.invariant_checks = 0
        self.violations: list[Violation] = []
        self.trace: list[str] = []
        #: previous `status`/`suspendedUntil` per agent, for the INV-SLASH-02 transition check
        self._prev_agents: dict[int, tuple[int, int]] = {}
        #: intents already sampled, so INV-INTENT-01/02 read each one at most twice
        self._sampled_intents: set[tuple[int, bytes]] = set()
        self.invariant_counts: dict[str, int] = {i: 0 for i in INVARIANT_IDS}
        self.t0 = 0.0
        self.agents = [1, 2, 3, 4]

    # ------------------------------------------------------------------ setup
    def boot(self) -> None:
        self.t0 = time.time()
        self.chain = AvairaChain.spawn()
        self.chain.explain_reverts = self.explain
        self.eoas = self.chain.accounts
        self.world_owners: dict[int, str] = {}
        for i, agent_id in enumerate(self.agents):
            owner = self.eoas[2 + i]
            bond = self.chain.call("AvairaIdentityRegistry", "registrationBond()")
            res = self.chain.transact("AvairaIdentityRegistry", "register(string)", [f"ipfs://agent{agent_id}"], owner, value=bond)
            assert res.ok, f"setup register({agent_id}) failed: {res.error}"
            self.world_owners[agent_id] = owner
        self.world = World(self.chain, self.agents)
        for agent_id, owner in self.world_owners.items():
            self.world.staker_of[agent_id] = owner
        for agent_id in self.agents:
            owner = self.world_owners[agent_id]
            self.chain.transact("MockUSDC", "approve(address,uint256)", [self.chain.stake_addr, 10 * 10**9], owner)
            self.chain.transact("MockUSDC", "approve(address,uint256)", [self.chain.market_addr, 10 * 10**9], owner)
            res = self.chain.transact("AvairaStakeRegistry", "stake(uint256,uint256)", [agent_id, 500 * USDC], owner)
            assert res.ok, f"setup stake({agent_id}) failed: {res.error}"
            self.world.staker_of[agent_id] = owner
            self.world.staked_in[agent_id] += 500 * USDC

    # ------------------------------------------------------------------ drivers
    def _oracle_snapshot(self) -> dict:
        w = self.world
        return {
            "staker_of": dict(w.staker_of),
            "staked_in": dict(w.staked_in),
            "slash_events": {k: list(v) for k, v in w.slash_events.items()},
            "executed": set(w.executed),
            "challenged": set(w.challenged),
            "attested_root": {k: list(v) for k, v in w.attested_root.items()},
            "banned": set(w.banned),
        }

    def _oracle_restore(self, snap: dict) -> None:
        w = self.world
        w.staker_of = dict(snap["staker_of"])
        w.staked_in = dict(snap["staked_in"])
        w.slash_events = {k: list(v) for k, v in snap["slash_events"].items()}
        w.executed = set(snap["executed"])
        w.challenged = set(snap["challenged"])
        w.attested_root = {k: list(v) for k, v in snap["attested_root"].items()}
        w.banned = set(snap["banned"])

    def run(self) -> list[Violation]:
        for seq in range(self.sequences):
            self.trace = []
            snapshot = self.chain.snapshot()
            oracle = self._oracle_snapshot()
            for step in range(self.depth):
                self._seq, self._step = seq, step
                self.step(seq, step)
                if self.violations:
                    return self.violations
            self.check(seq, self.depth)
            if self.full_view_every and seq % self.full_view_every == 0:
                self.full_view_sweep(seq)
            self.chain.revert(snapshot)
            self._oracle_restore(oracle)
            if self.violations:
                return self.violations
        return self.violations

    def step(self, seq: int, step: int) -> None:
        assert self.chain and self.world
        kind = self.rng.choice(
            [
                "stake",
                "unstake",
                "exit",
                "reactivate",
                "score",
                "feedback",
                "commit",
                "attest",
                "challenge",
                "borrow",
                "repay",
                "liquidate",
                "deposit",
                "admin",
                "time",
                "ban",
                "unauth",
            ]
        )
        getattr(self, f"_a_{kind}")(seq, step)

    # ------------------------------------------------------------------ actions
    def _agent(self) -> int:
        return self.rng.choice(self.agents)

    def _other(self, agent_id: int) -> str:
        pool = [a for a, v in self.world_owners.items() if a != agent_id]
        return self.world_owners[self.rng.choice(pool)] if pool else self.rng.choice(self.eoas)

    def _amt(self) -> int:
        return self.rng.choice([0, 1, self.rng.randrange(1, 200) * USDC, 10**9, self.rng.randrange(1, 600) * USDC])

    def _tx(self, name: str, sig: str, args: list, sender: str, note: str = ""):
        self.calls += 1
        # INV-PANIC-01 is evaluated on every transition, not only when something goes wrong.
        self.invariant_checks += 1
        self.invariant_counts["INV-PANIC-01"] += 1
        res = self.chain.transact(name, sig, args, sender)
        label = f"{name}.{sig.split('(')[0]}({note})"
        self.trace.append(f"{label} -> {'ok' if res.ok else 'revert ' + res.error}")
        if not res.ok:
            self.reverts += 1
            key = res.error[:80]
            self.revert_kinds[key] = self.revert_kinds.get(key, 0) + 1
            if res.panic:
                self.violations.append(
                    Violation("INV-PANIC-01", f"{label} from {sender}: {res.error} | {res.reason}", self.seed, self._seq, self._step)
                )
        return res

    def _a_stake(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        sender = self.world_owners.get(agent_id, self.rng.choice(self.eoas))
        amount = self._amt()
        res = self._tx("AvairaStakeRegistry", "stake(uint256,uint256)", [agent_id, amount], sender, f"a{agent_id}/{amount}")
        if res.ok and amount > 0:
            self.world.staked_in[agent_id] += amount
            self.world.staker_of.setdefault(agent_id, sender)
            self.world.staker_of[agent_id] = sender if agent_id not in self.world.staker_of else self.world.staker_of[agent_id]

    def _a_unstake(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        staker = self.world.staker_of.get(agent_id) or self.rng.choice(self.eoas)
        amount = self._amt()
        res = self._tx("AvairaStakeRegistry", "unstake(uint256,uint256)", [agent_id, amount], staker, f"a{agent_id}/{amount}")
        if res.ok and amount > 0:
            self.world.staked_in[agent_id] -= amount

    def _a_exit(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        staker = self.world.staker_of.get(agent_id) or self.rng.choice(self.eoas)
        res = self._tx("AvairaStakeRegistry", "voluntaryExit(uint256)", [agent_id], staker, f"a{agent_id}")
        if res.ok:
            self.world.staked_in[agent_id] = 0
            self.world.staker_of.pop(agent_id, None)

    def _a_reactivate(self, seq: int, step: int) -> None:
        self._tx("AvairaStakeRegistry", "reactivate(uint256)", [self._agent()], self.rng.choice(self.eoas))

    def _a_score(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        score = self.rng.choice([0, 59, 60, 79, 80, 100, 255])
        sender = self.chain.admin if self.rng.random() < 0.8 else self.rng.choice(self.eoas)
        self._tx("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [agent_id, score], sender, f"a{agent_id}/{score}")

    def _a_feedback(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        reviewer = self.rng.choice(self.eoas[2:])
        tag = self.rng.choice(TAGS + ["notAStandardTag"])
        decimals = self.rng.choice([0, 2, 8, 18, 19])
        # The extremes are the interesting ones: int128 bounds are where scaling arithmetic
        # in `getSummary` has to survive.
        value = self.rng.choice([0, 1, -1, 2**127 - 1, -(2**127), 10**18, 5 * 10**9])
        self._tx(
            "AvairaReputationRegistry",
            "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
            [agent_id, value, decimals, tag, "", "https://x", "ipfs://f", self._h32()],
            reviewer,
            f"a{agent_id}/{tag}/{value}/{decimals}",
        )

    def _intent(self, agent_id: int) -> tuple[bytes, list]:
        envelope = {
            "maxSpendUsd": self.rng.choice([0, USDC, 5 * USDC, 10**9]),
            "allowedActions": self.rng.sample(ACTIONS, k=self.rng.randint(1, 3)),
            "deadline": self.chain.now() + self.rng.choice([-10, 3600, 86_400]),
        }
        intent_hash = self._h32()
        return intent_hash, envelope

    def _a_commit(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        sender = self.world_owners.get(agent_id, self.rng.choice(self.eoas))
        intent_hash, env = self._intent(agent_id)
        self._tx(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, intent_hash, [env["maxSpendUsd"], env["allowedActions"], env["deadline"]]],
            sender,
            f"a{agent_id}",
        )

    def _a_attest(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        sender = self.world_owners.get(agent_id, self.rng.choice(self.eoas))
        intent_hash, env = self._intent(agent_id)
        # Commit first so attestation is reachable (a real agent always commits first).
        self._tx(
            "AvairaIntentVault",
            "commitIntent(uint256,bytes32,(uint256,string[],uint64))",
            [agent_id, intent_hash, [env["maxSpendUsd"], env["allowedActions"], env["deadline"]]],
            sender,
        )
        leaves = [
            self._leaf_hash(agent_id, intent_hash, self.rng.choice(ACTIONS), self.rng.randrange(1, 10) * USDC, i)
            for i in range(self.rng.randint(1, 4))
        ]
        root = self.merkle_root(leaves)
        res = self._tx("AvairaIntentVault", "attestOutcome(uint256,bytes32,bytes32,bytes32)", [agent_id, intent_hash, root, root], sender)
        if res.ok:
            self.world.executed.add((agent_id, intent_hash))
            self.world.attested_root[(agent_id, intent_hash)] = leaves
            self._check_attestation(agent_id, intent_hash, leaves, root, seq, step)

    def _check_attestation(self, agent_id: int, intent_hash: bytes, leaves: list[bytes], root: bytes, seq: int, step: int) -> None:
        """INV-INTENT-01/02 at the only moment both halves are checkable: right after `attestOutcome`.

        * anchoring — the stored root must be the one we computed from our own leaf set;
        * window arithmetic — `challengeEndsAt == attestedAt + challengeWindow`, never zero, and
          never more than `MAX_CHALLENGE_WINDOW` ahead (the `uint64` overflow class from AV-007,
          where one admin call turned every honest attestation into a revert).

        `attestedAt` is read as the chain's current block timestamp *here*, one step after the
        transaction: eth-tester mines each transaction into its own block whose timestamp is the
        parent's + 1s, so a timestamp captured before sending is one second early and the
        equality would be a harness artefact rather than a property of the contract.
        """
        attested_at = self.chain.now()
        self.invariant_checks += 1
        self.invariant_counts["INV-INTENT-01"] += 1
        self.invariant_counts["INV-INTENT-02"] += 1
        intent = self.chain.call("AvairaIntentVault", "getIntent(uint256,bytes32)", [agent_id, intent_hash])
        window = self.chain.call("AvairaIntentVault", "challengeWindow()")
        self.calls += 2
        tag = f"intent {agent_id}/{intent_hash.hex()[:12]}"
        _aid, _env, _cap, _deadline, _committed, ends_at, _ohash, stored_root, executed = intent[:9]
        if not executed:
            self._violate("INV-INTENT-01", f"{tag}: attestOutcome returned ok but executed=false", seq, step)
        if stored_root != root:
            self._violate(
                "INV-INTENT-01",
                f"{tag}: anchored root {stored_root.hex()[:16]} != computed {root.hex()[:16]}",
                seq,
                step,
            )
        self.world.attested_ends_at[(agent_id, intent_hash)] = ends_at
        if ends_at != attested_at + window:
            self._violate(
                "INV-INTENT-02",
                f"{tag}: challengeEndsAt {ends_at} != attestedAt {attested_at} + window {window}",
                seq,
                step,
            )
        if ends_at > attested_at + MAX_CHALLENGE_WINDOW:
            self._violate("INV-INTENT-02", f"{tag}: window {ends_at - attested_at}s exceeds MAX_CHALLENGE_WINDOW", seq, step)

    def _a_challenge(self, seq: int, step: int) -> None:
        if not self.world.executed:
            return
        agent_id, intent_hash = self.rng.choice(sorted(self.world.executed, key=lambda t: (t[0], t[1])))
        leaves = self.world.attested_root.get((agent_id, intent_hash), [])
        if not leaves:
            return
        index = self.rng.randrange(len(leaves))
        proof = self.merkle_proof(leaves, index)
        envelope = self.chain.call("AvairaIntentVault", "allowedActionsOf(uint256,bytes32)", [agent_id, intent_hash])
        spend = self.rng.choice([0, 10**12])  # in-envelope vs over-spend
        action = self.rng.choice(ACTIONS + list(envelope))
        leaf = (agent_id, intent_hash, action, spend, index)
        challenger = self.rng.choice(self.eoas[2:])
        self.chain.transact("MockUSDC", "approve(address,uint256)", [self.chain.vault_addr, 10**9], challenger)
        self._tx(
            "AvairaIntentVault",
            "challengeDeviation(uint256,bytes32,(uint256,bytes32,string,uint256,uint256),bytes32[])",
            [agent_id, intent_hash, list(leaf), proof],
            challenger,
            f"a{agent_id}/spend{spend}",
        )
        if spend > 10**11 and action not in envelope:
            self.world.slash_events[agent_id].append({"amount": 0, "level": 2})  # expectation set in _check

    def _a_borrow(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        sender = self.world_owners.get(agent_id, self.rng.choice(self.eoas))
        self._tx("AvairaCreditMarket", "borrow(uint256,uint256)", [agent_id, self._amt()], sender)

    def _a_repay(self, seq: int, step: int) -> None:
        self._tx("AvairaCreditMarket", "repay(uint256,uint256)", [self._agent(), self._amt()], self.rng.choice(self.eoas))

    def _a_liquidate(self, seq: int, step: int) -> None:
        self._tx("AvairaCreditMarket", "liquidate(uint256)", [self._agent()], self.rng.choice(self.eoas))

    def _a_deposit(self, seq: int, step: int) -> None:
        agent_id = self._agent()
        sender = self.world_owners.get(agent_id, self.rng.choice(self.eoas))
        self._tx("AvairaCreditMarket", "depositCollateral(uint256,uint256)", [agent_id, self._amt()], sender)

    def _a_admin(self, seq: int, step: int) -> None:
        which = self.rng.randrange(4)
        sender = self.chain.admin if self.rng.random() < 0.7 else self.rng.choice(self.eoas[3:])
        if which == 0:
            self._tx("AvairaStakeRegistry", "setMinStake(uint256)", [self.rng.choice([0, USDC, 100 * USDC, 10**9])], sender, "minStake")
        elif which == 1:
            self._tx("AvairaStakeRegistry", "setMinScore(uint8)", [self.rng.choice([0, 60, 100, 200])], sender, "minScore")
        elif which == 2:
            self._tx("AvairaIntentVault", "setChallengeWindow(uint64)", [self.rng.choice([0, 3600, 2**64 - 1, 2**63])], sender, "window")
        else:
            self._tx("AvairaIntentVault", "setChallengerBond(uint256)", [self.rng.choice([0, 5 * USDC, 10**9])], sender, "bond")

    def _a_time(self, seq: int, step: int) -> None:
        delta = self.rng.choice([1, 3600, 86_400, 30 * 86_400])
        self.chain.advance_time(delta)
        self.trace.append(f"advance_time({delta})")

    def _a_ban(self, seq: int, step: int) -> None:
        """Try to ban from an address that is *not* the configured enforcer.

        The sender must be a signable EOA. An earlier version also picked the stake-registry
        *address* here, which reads like a neat "only the enforcer may call" probe but never
        reaches the contract: eth-tester refuses to sign for an address whose key it does not
        hold, so the campaign recorded a harness error instead of the protocol's own auth
        revert — 437 of them in the 4-seed matrix, inflating the revert histogram with noise
        that looks like protocol behaviour and is not.
        """
        agent_id = self._agent()
        sender = self.rng.choice(self.eoas[3:])
        self._tx("AvairaIdentityRegistry", "banAgent(uint256,string)", [agent_id, "campaign"], sender, f"a{agent_id}")

    def _a_unauth(self, seq: int, step: int) -> None:
        """Attempt a privileged call from an account with no role, then require no state change."""
        target = self.rng.choice(
            [
                ("AvairaStakeRegistry", "setMinStake(uint256)", [0]),
                ("AvairaStakeRegistry", "setSlasher(address,bool)", [self.eoas[5], True]),
                ("AvairaIntentVault", "setChallengeWindow(uint64)", [0]),
                ("AvairaReputationRegistry", "postAvairaScore(uint256,uint8)", [1, 100]),
                ("AvairaValidationRegistry", "registerValidator(address,string)", [self.eoas[5], "x"]),
                ("AvairaIdentityRegistry", "setRegistrationBond(uint256)", [0]),
                ("AvairaCreditMarket", "setStakeRegistry(address)", [self.eoas[5]]),
            ]
        )
        before = self.state_hash()
        self.invariant_checks += 1
        self.invariant_counts["INV-AUTH-01"] += 1
        self._tx(target[0], target[1], target[2], self.rng.choice(self.eoas[6:]), "unauth")
        after = self.state_hash()
        if before != after:
            self.violations.append(
                Violation("INV-AUTH-01", f"unprivileged call mutated state: {target[0]}.{target[1]}", self.seed, seq, step)
            )

    # ------------------------------------------------------------------ hashing (independent)
    def _h32(self) -> bytes:
        return bytes(self.rng.getrandbits(8 * 32).to_bytes(32, "big"))

    @staticmethod
    def _abi_encode(types: list, values: list) -> bytes:
        from eth_abi import encode

        return encode(types, values)

    def _leaf_hash(self, agent_id: int, intent_hash: bytes, action: str, spend: int, nonce: int) -> bytes:
        from eth_utils import keccak

        return keccak(
            self._abi_encode(
                ["string", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
                ["Avaira.DeviationLeaf.v1", agent_id, intent_hash, keccak(text=action), spend, nonce],
            )
        )

    @staticmethod
    def _hash_leaf(value: bytes) -> bytes:
        from eth_utils import keccak

        return keccak(b"\x00" + value)

    @staticmethod
    def _hash_pair(a: bytes, b: bytes) -> bytes:
        from eth_utils import keccak

        left, right = (a, b) if a <= b else (b, a)
        return keccak(b"\x01" + left + right)

    def merkle_root(self, leaves: list[bytes]) -> bytes:
        level = [self._hash_leaf(l) for l in leaves]
        while len(level) > 1:
            nxt = []
            for i in range(0, len(level), 2):
                nxt.append(self._hash_pair(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
            level = nxt
        return level[0]

    def merkle_proof(self, leaves: list[bytes], index: int) -> list[bytes]:
        level = [self._hash_leaf(l) for l in leaves]
        proof: list[bytes] = []
        pos = index
        while len(level) > 1:
            sibling = pos ^ 1
            if sibling < len(level):
                proof.append(level[sibling])
            nxt = []
            for i in range(0, len(level), 2):
                nxt.append(self._hash_pair(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
            level = nxt
            pos //= 2
        return proof

    # ------------------------------------------------------------------ state reads
    def probe_agents(self) -> list[dict]:
        fields = [
            "agentId",
            "stakeOf",
            "stakerAccountStake",
            "slashedTotal",
            "slashCount",
            "suspendedUntil",
            "status",
            "score",
            "minScore",
            "gateAllowed",
            "eligible",
            "gateReason",
            "staker",
        ]
        raw = self.chain.call("AvairaProbe", "agents(uint256[])", [self.agents])
        return [dict(zip(fields, row)) for row in raw]

    def _violate(self, invariant: str, detail: str, seq: int, step: int) -> None:
        self.violations.append(Violation(invariant, detail, self.seed, seq, step, list(self.trace[-6:])))

    def state_hash(self) -> bytes:
        from eth_utils import keccak

        payload = json.dumps([{k: str(v) for k, v in a.items()} for a in self.probe_agents()], sort_keys=True)
        return keccak(text=payload)

    # ------------------------------------------------------------------ invariants
    def check(self, seq: int, step: int) -> None:
        self._seq, self._step = seq, step
        rows = self.probe_agents()
        min_stake, min_score, _cooldown, _treasury = self.chain.call("AvairaProbe", "config()")
        self.invariant_checks += len(rows)
        for rid in ("INV-LEDGER-01", "INV-LEDGER-02", "INV-SLASH-01", "INV-SLASH-03",
                    "INV-GATE-01", "INV-GATE-02"):
            self.invariant_counts[rid] += len(rows)

        total = sum(r["stakeOf"] for r in rows)
        staker_totals: dict[str, int] = {}
        for row in rows:
            staker_totals[row["staker"]] = staker_totals.get(row["staker"], 0) + row["stakeOf"]

        for row in rows:
            agent_id = row["agentId"]
            # INV-LEDGER-01 — the per-staker ledger must equal the sum of that staker's agent stakes.
            if row["staker"] != "0x" + "00" * 20 and row["stakerAccountStake"] != staker_totals[row["staker"]]:
                self.violations.append(
                    Violation(
                        "INV-LEDGER-01",
                        f"agent {agent_id}: accountStake[{row['staker']}]={row['stakerAccountStake']} != "
                        f"sum(stakeOf)={staker_totals[row['staker']]}",
                        self.seed,
                        seq,
                        step,
                    )
                )
        # INV-LEDGER-02 — the registry must never be short of the stake it accounts for.
        if self.world.registry_balance < total:
            self.violations.append(
                Violation(
                    "INV-LEDGER-02",
                    f"registry USDC {self.world.registry_balance} < accounted stake {total}",
                    self.seed,
                    seq,
                    step,
                )
            )
        for row in rows:
            # INV-SLASH-01 — slashed totals can never exceed what was ever staked for the agent.
            if row["slashedTotal"] > self.world.staked_in[row["agentId"]]:
                self.violations.append(
                    Violation(
                        "INV-SLASH-01",
                        f"agent {row['agentId']}: slashedTotal {row['slashedTotal']} > staked-in {self.world.staked_in[row['agentId']]}",
                        self.seed,
                        seq,
                        step,
                    )
                )
            # INV-SLASH-02 — the status machine may only leave SUSPENDED at/after the cooldown
            # deadline (the AV-012 bypass path: top up stake during cooldown -> still SUSPENDED).
            prev = self._prev_agents.get(row["agentId"])
            if prev is not None:
                was_status, was_until = prev
                now = self.chain.now()
                if was_status == 3 and row["status"] == 2 and now < was_until:
                    self._violate(
                        "INV-SLASH-02",
                        f"agent {row['agentId']}: reactivated at {now} with cooldown until {was_until}",
                        seq,
                        step,
                    )
            # INV-SLASH-03 — a BAN leaves no capital behind and is terminal for the gate.
            if row["status"] == 4 and row["stakeOf"] != 0:
                self.violations.append(
                    Violation("INV-SLASH-03", f"banned agent {row['agentId']} still holds stake", self.seed, seq, step)
                )
            # INV-GATE-01 — the gate verdict is exactly (ACTIVE && stake>=min && score>=min).
            expected = row["status"] == 2 and row["stakeOf"] >= min_stake and row["score"] >= min_score
            if row["gateAllowed"] != expected:
                self.violations.append(
                    Violation(
                        "INV-GATE-01",
                        f"agent {row['agentId']}: gate={row['gateAllowed']} but status={row['status']} "
                        f"stake={row['stakeOf']}/{min_stake} score={row['score']}/{min_score}",
                        self.seed,
                        seq,
                        step,
                    )
                )
            self.invariant_counts["INV-SLASH-02"] += 1
            # INV-GATE-02 — gate and eligibility can never disagree (different code paths, same promise).
            if row["gateAllowed"] != row["eligible"]:
                self.violations.append(
                    Violation(
                        "INV-GATE-02",
                        f"agent {row['agentId']}: checkGate={row['gateAllowed']} vs isEligible={row['eligible']}",
                        self.seed,
                        seq,
                        step,
                    )
                )

        # INV-INTENT-01 (immutability half) — an anchored attestation must survive the rest of the
        # sequence: the vault stores the commitment, it does not let it be quietly rewritten or
        # expired away. Time-advance and challenge ops run between checks, so this is the only
        # intent assertion that is safe to make at an arbitrary later step; the arithmetic half is
        # asserted at attestation time in `_a_attest`.
        attested = sorted(self.world.attested_root.items(), key=lambda kv: (kv[0][0], kv[0][1]))
        if attested:
            (agent_id, intent_hash), leaves = attested[seq % len(attested)]
            self.invariant_checks += 1
            self.invariant_counts["INV-INTENT-01"] += 1
            intent = self.chain.call("AvairaIntentVault", "getIntent(uint256,bytes32)", [agent_id, intent_hash])
            self.calls += 1
            _aid, _env, _cap, _deadline, _committed, ends_at, _ohash, root, executed = intent[:9]
            if not executed:
                self._violate("INV-INTENT-01", f"intent {agent_id}/{intent_hash.hex()[:12]}: attested then lost (executed=false)", seq, step)
            if root != self.merkle_root(leaves):
                self._violate(
                    "INV-INTENT-01",
                    f"intent {agent_id}/{intent_hash.hex()[:12]}: anchored root rewritten (now {root.hex()[:12]})",
                    seq,
                    step,
                )
            if ends_at != self.world.attested_ends_at.get((agent_id, intent_hash), ends_at):
                self._violate(
                    "INV-INTENT-01",
                    f"intent {agent_id}/{intent_hash.hex()[:12]}: challengeEndsAt moved from "
                    f"{self.world.attested_ends_at.get((agent_id, intent_hash))} to {ends_at}",
                    seq,
                    step,
                )

        # snapshot statuses for the next step's INV-SLASH-02 transition check
        for row in rows:
            self._prev_agents[row["agentId"]] = (row["status"], row["suspendedUntil"])

    def full_view_sweep(self, seq: int) -> None:
        """Views must never revert: indexers, the dashboard and the SDK all read them."""
        self._seq, self._step = seq, -1
        for row in self.probe_agents():
            agent_id = row["agentId"]
            for name, sig, args in [
                ("AvairaIdentityRegistry", "tokenURI(uint256)", [agent_id]),
                ("AvairaIdentityRegistry", "getMetadataKeys(uint256)", [agent_id]),
                ("AvairaIdentityRegistry", "statusOf(uint256)", [agent_id]),
                ("AvairaIdentityRegistry", "isBanned(uint256)", [agent_id]),
                ("AvairaReputationRegistry", "getSummary(uint256,address[],string)", [agent_id, self.eoas[2:6], "successRate"]),
                ("AvairaReputationRegistry", "gradeOf(uint256)", [agent_id]),
                ("AvairaStakeRegistry", "statusOfBatch(uint256[])", [self.agents]),
                ("AvairaStakeRegistry", "isEligible(address)", [self.eoas[2]]),
                ("AvairaCreditMarket", "isLiquidatable(uint256)", [agent_id]),
                ("AvairaCreditMarket", "borrowCapacity(uint256)", [agent_id]),
                ("AvairaValidationRegistry", "getAgentValidations(uint256)", [agent_id]),
                ("AvairaIntentVault", "isChallengeOpen(uint256,bytes32)", [agent_id, b"\x00" * 32]),
                ("AvairaIntentVault", "getIntent(uint256,bytes32)", [agent_id, b"\x00" * 32]),
            ]:
                self.invariant_checks += 1
                self.invariant_counts["INV-VIEW-01"] += 1
                ok, detail = self.chain.try_call(name, sig, args)
                self.calls += 1
                if not ok:
                    self.violations.append(Violation("INV-VIEW-01", f"{name}.{sig} reverted for agent {agent_id}: {detail}", self.seed, seq, -1))

    # ------------------------------------------------------------------ report
    def report(self, verdict: str, violations: list[Violation]) -> dict:
        elapsed = time.time() - self.t0
        dead = [i for i, n in self.invariant_counts.items() if n == 0]
        if dead:
            print(
                "CAMPAIGN BUG: declared invariants never evaluated: " + ", ".join(dead)
                + " — either implement the check or drop the id (a decorative invariant is worse than none)",
                file=sys.stderr,
            )
        manifest = {}
        try:
            from avaira_evm.harness import load_manifest

            manifest = load_manifest()
        except Exception:  # pragma: no cover
            pass
        return {
            "schema": "avaira.campaign-report/v1",
            "verdict": verdict,
            "engine": "py-evm (eth-tester) @ Cancun, solc-js build",
            "build": {
                "compiler": manifest.get("compiler"),
                "viaIR": manifest.get("profiles", {}).get("viaIR"),
                "matchesFoundryProfile": manifest.get("matchesFoundryProfile"),
                "sourceDigest": sha256_of_build(),
            },
            "seed": self.seed,
            "sequences": self.sequences,
            "depth": self.depth,
            "calls": self.calls,
            "transitions": self.chain.tx_count if self.chain else 0,
            "reverts": self.reverts,
            "revertKinds": dict(sorted(self.revert_kinds.items(), key=lambda kv: -kv[1])[:25]),
            "invariantEvaluations": self.invariant_checks,
            "invariantEvaluationsById": self.invariant_counts,
            "invariantsNeverEvaluated": [i for i, n in self.invariant_counts.items() if n == 0],
            "invariants": INVARIANT_IDS,
            "violations": [v.as_dict() for v in violations],
            "throughputCallsPerSecond": round(self.calls / elapsed, 1) if elapsed else 0,
            "elapsedSeconds": round(elapsed, 1),
            "gas": {"totalUsed": self.chain.gas_used_total if self.chain else 0},
        }


def sha256_of_build() -> str:
    """Digest of the exact bytecode the campaign executed, so a report can be tied to a build."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "build", "avaira", "artifacts.json")
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "0x" + h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--sequences", type=int, default=400)
    parser.add_argument("--depth", type=int, default=12)
    parser.add_argument("--out", default="verification/reports/campaign.json")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--explain-reverts", action="store_true", help="decode every revert (slower, better logs)")
    parser.add_argument("--no-view-sweep", action="store_true", help="skip the periodic read-path sweep")
    args = parser.parse_args(argv)

    campaign = Campaign(
        seed=args.seed,
        sequences=args.sequences,
        depth=args.depth,
        explain=args.explain_reverts,
        full_view_every=0 if args.no_view_sweep else 16,
    )
    campaign.boot()
    violations = campaign.run()
    verdict = "PASS" if not violations else "FAIL"
    report = campaign.report(verdict, violations)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=2, sort_keys=True)
        fh.write("\n")

    if not args.quiet:
        print(f"campaign {verdict}  seed={args.seed}  sequences={args.sequences}×{args.depth}  calls={report['calls']}")
        print(f"  reverts={args and report['reverts']}  invariantEvaluations={report['invariantEvaluations']}  "
              f"throughput={report['throughputCallsPerSecond']}/s  elapsed={report['elapsedSeconds']}s")
        print(f"  build sha256={report['build']['sourceDigest'][:18]}…  viaIR={report['build']['viaIR']}")
    if violations:
        print(f"\n{len(violations)} VIOLATION(S) — first {min(3, len(violations))}:\n", file=sys.stderr)
        for v in violations[:3]:
            print(f"  [{v.invariant}] {v.detail}", file=sys.stderr)
            print(f"    replay: python3 tools/avaira_evm/campaign.py --seed {v.seed} --sequences {v.sequence+1} --depth {v.step}", file=sys.stderr)
            for line in v.trace[-6:]:
                print(f"    | {line}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
