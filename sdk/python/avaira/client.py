"""`avaira.run(task, execute_fn)` — the onchain gate, for Python agents.

    from avaira import Avaira, RiskEnvelope

    avaira = Avaira.from_deployment(chain_id=10143, private_key=os.environ["AGENT_KEY"])

    result = avaira.run(
        agent_id,
        {"id": "invoice-4821"},
        lambda ctx: reconcile(ctx.audit),
        envelope=RiskEnvelope(max_spend_usd=5_000_000, allowed_actions=["web.search", "mcp.call"], deadline=...),
    )

    if result.status == "blocked":
        print("gate refused:", result.message)   # execute_fn never ran
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import httpx
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address
from web3 import Web3

from .abis import (
    ERC20_ABI,
    IDENTITY_REGISTRY_ABI,
    INTENT_VAULT_ABI,
    REPUTATION_REGISTRY_ABI,
    STAKE_REGISTRY_ABI,
)
from .audit import AuditTrail
from .types import (
    BlockedRun,
    CompletedRun,
    GateReason,
    GateTimings,
    GATE_REASON_TEXT,
    RiskEnvelope,
    RunResult,
)

ENVELOPE_TYPEHASH = keccak(b"RiskEnvelope(uint256 maxSpendUsd,bytes32 allowedActionsHash,uint64 deadline)")

MANIFEST_SEARCH_PATHS = (
    "deployments/{chain}.json",
    "../deployments/{chain}.json",
    "../../deployments/{chain}.json",
    "../../../deployments/{chain}.json",
    "../../../../deployments/{chain}.json",
)


@dataclass
class ExecutionContext:
    """Handed to `execute_fn`. Everything the agent needs to record what it actually did."""

    audit: AuditTrail
    envelope: RiskEnvelope
    intent_hash: str
    agent_id: int


class AvairaError(RuntimeError):
    pass


class Avaira:
    def __init__(
        self,
        rpc_url: str,
        chain_id: int,
        contracts: dict[str, str],
        private_key: str | None = None,
        account: Any | None = None,
        metrics_url: str | None = None,
        commit_visibility_timeout_ms: int = 2_000,
        poll_interval_ms: int = 100,
        gas_multiplier: float = 1.2,
    ) -> None:
        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))
        self.chain_id = chain_id
        self.contracts = {k: to_checksum_address(v) for k, v in contracts.items() if v}
        self.metrics_url = metrics_url
        self.commit_visibility_timeout_ms = commit_visibility_timeout_ms
        self.poll_interval_ms = poll_interval_ms
        self.gas_multiplier = gas_multiplier

        if private_key:
            self.account = Account.from_key(private_key)
        elif account is not None:
            self.account = account
        else:
            self.account = None
        self.address = getattr(self.account, "address", None)

        self.vault = self.w3.eth.contract(address=self.contracts["intentVault"], abi=INTENT_VAULT_ABI)
        self.stake_registry = self.w3.eth.contract(address=self.contracts["stakeRegistry"], abi=STAKE_REGISTRY_ABI)
        self.identity = self.w3.eth.contract(address=self.contracts["identityRegistry"], abi=IDENTITY_REGISTRY_ABI)
        self.reputation = self.w3.eth.contract(address=self.contracts["reputationRegistry"], abi=REPUTATION_REGISTRY_ABI)

    # ── construction helpers ─────────────────────────────────────────────────────

    @classmethod
    def load_manifest(cls, chain_id: int, path: str | Path | None = None) -> dict[str, Any]:
        """Locates `deployments/{chain_id}.json` (written by the deploy script).

        Resolution order: explicit path → `$AVAIRA_DEPLOYMENT` → walking up from the cwd.
        Keeping one manifest for the SDK, scorer, gateway and dashboard means an address is
        never hand-copied into a second place where it can go stale.
        """
        candidates: list[Path] = []
        if path:
            candidates.append(Path(path))
        if os.environ.get("AVAIRA_DEPLOYMENT"):
            candidates.append(Path(os.environ["AVAIRA_DEPLOYMENT"]))
        candidates += [Path(p.format(chain=chain_id)) for p in MANIFEST_SEARCH_PATHS]
        candidates.append(Path(__file__).resolve().parents[3] / "deployments" / f"{chain_id}.json")

        for candidate in candidates:
            if candidate.is_file():
                with candidate.open() as handle:
                    return json.load(handle)
        raise AvairaError(
            f"no deployment manifest for chain {chain_id}. Deploy first (make deploy-monad), "
            f"or point $AVAIRA_DEPLOYMENT at deployments/{chain_id}.json"
        )

    @classmethod
    def from_deployment(
        cls,
        chain_id: int = 10143,
        private_key: str | None = None,
        rpc_url: str | None = None,
        manifest_path: str | Path | None = None,
        **kwargs: Any,
    ) -> "Avaira":
        manifest = cls.load_manifest(chain_id, manifest_path)
        default_rpc = (
            "https://testnet-rpc.monad.xyz"
            if chain_id == 10143
            else "https://rpc.monad.xyz"
            if chain_id == 143
            else "http://127.0.0.1:8545"
        )
        return cls(
            rpc_url=rpc_url or os.environ.get("AVAIRA_RPC_URL", default_rpc),
            chain_id=chain_id,
            contracts=manifest,
            private_key=private_key or os.environ.get("AVAIRA_PRIVATE_KEY"),
            metrics_url=kwargs.pop("metrics_url", os.environ.get("AVAIRA_METRICS_URL")),
            **kwargs,
        )

    # ── the product ──────────────────────────────────────────────────────────────

    def run(
        self,
        agent_id: int,
        task: dict[str, Any],
        execute_fn: Callable[[ExecutionContext], Any],
        envelope: RiskEnvelope | None = None,
        audit: bool = True,
        record_decisions: bool = False,
    ) -> RunResult:
        """Runs `execute_fn` behind the gate. `execute_fn` is never called when blocked."""
        if self.account is None:
            raise AvairaError("run() needs a signer: pass private_key= or account=")

        envelope = envelope or RiskEnvelope(
            max_spend_usd=0,
            allowed_actions=[],
            deadline=int(time.time()) + 3600,
        )
        nonce = self._next_nonce()
        envelope_hash = self.hash_envelope(envelope)
        intent_hash = self.hash_intent(agent_id, task, envelope_hash, nonce)
        timings = GateTimings()

        # 1. agent-level gate — free, one eth_call, no commitment needed
        start = time.perf_counter()
        allowed, score, reason = self.check_gate(agent_id)
        timings.agent_gate_ms = _ms(start)

        if not allowed:
            self._report(agent_id, intent_hash, False, reason, score, timings)
            return BlockedRun(
                status="blocked",
                agent_id=agent_id,
                intent_hash=intent_hash,
                score=score,
                reason=reason,
                message=GATE_REASON_TEXT[reason],
                timings=timings,
            )

        # 2. commit the plan — fire and forget, never wait for a receipt
        start = time.perf_counter()
        commit_tx = self.commit_intent(agent_id, intent_hash, envelope)
        timings.commit_submit_ms = _ms(start)

        # 3. gate again, now bound to the commitment
        gate = self.wait_for_intent_gate(agent_id, intent_hash, envelope_hash)
        timings.gate_latency_ms = _ms(start)
        timings.intent_visible = gate.allowed
        final_score = gate.score or score

        if not gate.allowed:
            decision_tx = None
            if record_decisions:
                decision_tx = self.record_gate_decision(agent_id, intent_hash, False, gate.reason, int(timings.gate_latency_ms))
            self._report(agent_id, intent_hash, False, gate.reason, final_score, timings)
            return BlockedRun(
                status="blocked",
                agent_id=agent_id,
                intent_hash=intent_hash,
                score=final_score,
                reason=gate.reason,
                message=GATE_REASON_TEXT[gate.reason],
                timings=timings,
                commit_tx_hash=commit_tx,
                decision_tx_hash=decision_tx,
            )

        # 4. execute, hash-chaining every action locally
        trail = AuditTrail(agent_id=agent_id, intent_hash=intent_hash)
        context = ExecutionContext(audit=trail, envelope=envelope, intent_hash=intent_hash, agent_id=agent_id)
        start = time.perf_counter()
        try:
            result = execute_fn(context)
        finally:
            timings.execution_ms = _ms(start)

        # 5. anchor the outcome + Merkle root of the trail
        start = time.perf_counter()
        merkle_root = trail.merkle_root()
        attest_tx = self.attest_outcome(agent_id, intent_hash, trail.head, merkle_root) if audit else None
        timings.attest_ms = _ms(start)
        timings.total_ms = timings.gate_latency_ms + timings.execution_ms

        self._report(agent_id, intent_hash, True, GateReason.ALLOWED, final_score, timings, audit_entries=trail.size)
        return CompletedRun(
            status="completed",
            agent_id=agent_id,
            intent_hash=intent_hash,
            outcome_hash=trail.head,
            merkle_root=merkle_root,
            score=final_score,
            timings=timings,
            commit_tx_hash=commit_tx,
            attest_tx_hash=attest_tx,
            audit_entries=trail.size,
            result=result,
        )

    # ── onchain surface ──────────────────────────────────────────────────────────

    def check_gate(self, agent_id: int) -> tuple[bool, int, GateReason]:
        allowed, score, reason = self.vault.functions.checkGate(agent_id).call()
        return bool(allowed), int(score), GateReason(int(reason))

    def check_gate_for_intent(self, agent_id: int, intent_hash: str, envelope_hash: str) -> tuple[bool, int, GateReason]:
        allowed, score, reason = self.vault.functions.checkGate(agent_id, _b32(intent_hash), _b32(envelope_hash)).call()
        return bool(allowed), int(score), GateReason(int(reason))

    def commit_intent(self, agent_id: int, intent_hash: str, envelope: RiskEnvelope) -> str:
        tx = self.vault.functions.commitIntent(agent_id, _b32(intent_hash), envelope.as_tuple)
        return self._send(tx)

    def attest_outcome(self, agent_id: int, intent_hash: str, outcome_hash: str, merkle_root: str) -> str:
        tx = self.vault.functions.attestOutcome(agent_id, _b32(intent_hash), _b32(outcome_hash), _b32(merkle_root))
        return self._send(tx)

    def record_gate_decision(self, agent_id: int, intent_hash: str, allowed: bool, reason: GateReason, latency_ms: int) -> str | None:
        try:
            tx = self.vault.functions.recordGateDecision(agent_id, _b32(intent_hash), allowed, int(reason), min(int(latency_ms), 0xFFFFFFFF))
            return self._send(tx)
        except Exception:
            return None

    def wait_for_intent_gate(
        self,
        agent_id: int,
        intent_hash: str,
        envelope_hash: str,
        timeout_ms: int | None = None,
    ) -> tuple[bool, int, GateReason]:
        """Polls until the commitment is visible to the gate.

        Waits on *speculative* inclusion (`eth_call` at latest), never on finality: a gate
        that waited for finality on every action would be slower than the actions it guards.
        """
        budget = self.commit_visibility_timeout_ms if timeout_ms is None else timeout_ms
        deadline = time.perf_counter() + budget / 1000
        last: tuple[bool, int, GateReason] = (False, 0, GateReason.INTENT_NOT_COMMITTED)

        while True:
            try:
                last = self.check_gate_for_intent(agent_id, intent_hash, envelope_hash)
                if last[0] or last[2] != GateReason.INTENT_NOT_COMMITTED:
                    return last
            except Exception:
                pass  # transient RPC hiccup: keep polling within the budget
            if time.perf_counter() >= deadline:
                return last
            time.sleep(self.poll_interval_ms / 1000)

    def status_of(self, agent_id: int) -> int:
        return int(self.stake_registry.functions.statusOf(agent_id).call())

    def stake_of(self, agent_id: int) -> int:
        return int(self.stake_registry.functions.stakeOf(agent_id).call())

    def score_of(self, agent_id: int) -> int:
        return int(self.reputation.functions.scoreOf(agent_id).call())

    def grade_of(self, agent_id: int) -> str:
        return self.reputation.functions.gradeOf(agent_id).call()

    def is_eligible(self, agent_id: int) -> bool:
        return bool(self.stake_registry.functions.isEligible(agent_id).call())

    # ── hashing ──────────────────────────────────────────────────────────────────

    def hash_envelope(self, envelope: RiskEnvelope) -> str:
        """EIP-712-style struct hash, identical to `RiskEnvelopeLib.hash`."""
        actions_hash = keccak(abi_encode(["string[]"], [envelope.allowed_actions]))
        encoded = abi_encode(
            ["bytes32", "uint256", "bytes32", "uint64"],
            [ENVELOPE_TYPEHASH, envelope.max_spend_usd, actions_hash, envelope.deadline],
        )
        return "0x" + keccak(encoded).hex()

    def hash_intent(self, agent_id: int, task: dict[str, Any], envelope_hash: str, nonce: int) -> str:
        # `canonicalJson` in @avaira/sdk pins the same bytes: keys sorted at every depth,
        # printable-ASCII only, no insignificant whitespace. See FINDINGS.md AV-013.
        task_json = json.dumps(task, sort_keys=True, separators=(",", ":"))
        encoded = abi_encode(
            ["string", "uint256", "string", "string", "bytes32", "uint256"],
            ["Avaira.Intent.v1", agent_id, str(task.get("id", "")), task_json, _b32(envelope_hash), nonce],
        )
        return "0x" + keccak(encoded).hex()

    # ── internals ────────────────────────────────────────────────────────────────

    def _send(self, tx) -> str:
        if self.account is None:
            raise AvairaError("no signer configured")
        tx = tx.build_transaction(
            {
                "from": self.address,
                "nonce": self.w3.eth.get_transaction_count(self.address),
                "chainId": self.chain_id,
                "gas": int(self.w3.eth.estimate_gas(
                    {
                        "from": self.address,
                        "to": tx.address,
                        "data": tx.data,
                    }
                ) * self.gas_multiplier),
            }
        )
        signed = self.account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
        return self.w3.eth.send_raw_transaction(raw).hex()

    def _next_nonce(self) -> int:
        return uuid.uuid4().int >> 64

    def _report(
        self,
        agent_id: int,
        intent_hash: str,
        allowed: bool,
        reason: GateReason,
        score: int,
        timings: GateTimings,
        audit_entries: int | None = None,
    ) -> None:
        if not self.metrics_url:
            return
        payload = {
            "agentId": str(agent_id),
            "intentHash": intent_hash,
            "allowed": allowed,
            "reason": int(reason),
            "score": score,
            "timings": timings.as_dict(),
            "auditEntries": audit_entries,
            "chainId": self.chain_id,
            "source": "sdk-python",
        }
        try:
            httpx.post(f"{self.metrics_url.rstrip('/')}/api/metrics", json=payload, timeout=2.0)
        except Exception:
            pass  # telemetry must never be able to stop a gated action


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def _b32(value: str) -> bytes:
    raw = value[2:] if value.startswith("0x") else value
    return bytes.fromhex(raw.rjust(64, "0"))
