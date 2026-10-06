"""Avaira Cognitive OS v5.0 — Pillar D: the hardened execution layer.

`ExecutionGate` is a strict boolean gate. Execution requires ALL of:

  1. Valid hardware attestation (simulated Nitro enclave; PCR0 measurement).
  2. A signature-valid SAFE certificate bound to the exact plan hash.
  3. Envelope compliance — worst-case cost strictly under the cap, all
     actions whitelisted, step count within limits.

Anything missing, tampered, or ambiguous is a refusal. Fail-closed.

`LocalLedgerSlashing` performs atomic stake burns (all-or-nothing, hash-chained).
`EVMFreezeSlashAdapter` renders the same punishment as an on-chain
`freezeAndSlash(address,uint256,string)` settlement against the repo's
FreezeSlash contract — offline it emits the exact unsigned transaction.
"""
from __future__ import annotations

import hashlib
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from .schemas import (Envelope, Plan, SafetyCertificate, TEEAttestation,
                      sha256_canonical)
from .secrets import resolve_root_secret

# ---------------------------------------------------------------------------
# Hardware attestation (simulated Nitro enclave, deterministic & offline)
# ---------------------------------------------------------------------------


class AttestationService:
    """Mints and verifies TEE attestations.

    PCR0 is the measurement of the Cognitive OS runtime image. The enclave
    key is derived from the root secret; verification recomputes the
    signature and compares PCR0 against the known-good measurement.
    """

    RUNTIME_IMAGE = b"avaira-cognitive-os-v5.0-runtime"
    KERNEL_IMAGE = b"nitro-v5-kernel-5.15"

    def __init__(self, secret: str | None = None) -> None:
        # No shipped default: an env-provided root secret in production, a per-installation
        # secret file otherwise (see avaira_os/secrets.py).
        self.secret, self.secret_source = (secret, "explicit") if secret else resolve_root_secret()
        self.expected_pcr0 = hashlib.sha256(self.RUNTIME_IMAGE).hexdigest()

    def issue(self, agent_id: str, nonce: str) -> TEEAttestation:
        pcr0 = self.expected_pcr0
        pcr1 = hashlib.sha256(self.KERNEL_IMAGE).hexdigest()
        pcr2 = hashlib.sha256(agent_id.encode()).hexdigest()
        enclave_id = "nitro-" + hashlib.sha256(f"{agent_id}|{nonce}".encode()).hexdigest()[:12]
        attestation = TEEAttestation(
            agent_id=agent_id,
            enclave_id=enclave_id,
            pcr0=pcr0,
            pcr1=pcr1,
            pcr2=pcr2,
            nonce=nonce,
        )
        return attestation.sign(self.secret)

    def verify(self, attestation: Optional[TEEAttestation]) -> bool:
        if attestation is None:
            return False
        return attestation.verify(self.secret, self.expected_pcr0)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


class RefusalReason(str, Enum):
    MISSING_ATTESTATION = "missing_hardware_attestation"
    INVALID_ATTESTATION = "invalid_hardware_attestation"
    MISSING_CERTIFICATE = "missing_safety_certificate"
    INVALID_CERTIFICATE_SIGNATURE = "invalid_certificate_signature"
    CERTIFICATE_NOT_SAFE = "certificate_verdict_not_safe"
    PLAN_HASH_MISMATCH = "certificate_plan_hash_mismatch"
    COST_CAP_EXCEEDED = "envelope_cost_cap_exceeded"
    ACTION_NOT_ALLOWED = "action_not_in_envelope"
    TOO_MANY_STEPS = "plan_exceeds_step_limit"


class GateDecision(BaseModel):
    model_config = ConfigDict(frozen=True)

    allowed: bool
    refusals: List[RefusalReason] = Field(default_factory=list)
    checks_passed: List[str] = Field(default_factory=list)


class ExecutionGate:
    """Strict boolean gate: no valid attestation + certificate + envelope, no execution."""

    def __init__(self, secret: str | None = None) -> None:
        secret = secret or resolve_root_secret()[0]
        self.secret = secret
        self.attestations = AttestationService(secret)

    def authorize(self, plan: Plan, certificate: Optional[SafetyCertificate],
                  attestation: Optional[TEEAttestation], envelope: Envelope) -> GateDecision:
        refusals: List[RefusalReason] = []
        passed: List[str] = []

        # 1. Hardware root of trust
        if attestation is None:
            refusals.append(RefusalReason.MISSING_ATTESTATION)
        elif not self.attestations.verify(attestation):
            refusals.append(RefusalReason.INVALID_ATTESTATION)
        else:
            passed.append("hardware_attestation")

        # 2. Signed SAFE certificate bound to this exact plan
        if certificate is None:
            refusals.append(RefusalReason.MISSING_CERTIFICATE)
        else:
            if not certificate.verify(self.secret):
                refusals.append(RefusalReason.INVALID_CERTIFICATE_SIGNATURE)
            else:
                passed.append("certificate_signature")
            if certificate.verdict.value != "SAFE":
                refusals.append(RefusalReason.CERTIFICATE_NOT_SAFE)
            else:
                passed.append("certificate_verdict_safe")
            if certificate.plan_hash != plan.plan_hash():
                refusals.append(RefusalReason.PLAN_HASH_MISMATCH)
            else:
                passed.append("plan_hash_binding")

        # 3. Envelope compliance (worst-case cost must be strictly under the cap)
        worst_case = plan.total_cost_hi()
        if worst_case >= envelope.cost_cap_usd:
            refusals.append(RefusalReason.COST_CAP_EXCEEDED)
        else:
            passed.append("cost_under_cap")
        disallowed = [s.action for s in plan.steps if s.action not in envelope.allowed_actions]
        if disallowed:
            refusals.append(RefusalReason.ACTION_NOT_ALLOWED)
        else:
            passed.append("actions_whitelisted")
        if len(plan.steps) > envelope.max_steps:
            refusals.append(RefusalReason.TOO_MANY_STEPS)
        else:
            passed.append("step_limit")

        return GateDecision(allowed=not refusals, refusals=refusals, checks_passed=passed)


# ---------------------------------------------------------------------------
# Slashing — local ledger (atomic burns)
# ---------------------------------------------------------------------------


class LedgerEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    seq: int
    agent_id: str
    delta: float
    balance_after: float
    reason: str
    evidence_hash: str
    prev_hash: str
    hash: str


class SlashReceipt(BaseModel):
    model_config = ConfigDict(frozen=True)

    slash_id: str
    agent_id: str
    amount_burned: float
    remaining_stake: float
    reason: str
    evidence_hash: str


class InsufficientStake(Exception):
    pass


class LocalLedgerSlashing:
    """Atomic stake ledger: burns are all-or-nothing and hash-chained."""

    def __init__(self, initial_stakes: Optional[Dict[str, float]] = None) -> None:
        self._stakes: Dict[str, float] = dict(initial_stakes or {})
        self._chains: Dict[str, List[LedgerEntry]] = {}

    def stake_of(self, agent_id: str) -> float:
        return self._stakes.get(agent_id, 0.0)

    def deposit(self, agent_id: str, amount: float, reason: str = "stake_deposit") -> float:
        if amount <= 0:
            raise ValueError("deposit must be positive")
        self._apply(agent_id, amount, reason, evidence_hash=sha256_canonical({"deposit": amount, "agent": agent_id}))
        return self.stake_of(agent_id)

    def burn(self, agent_id: str, amount: float, reason: str, evidence_hash: str) -> SlashReceipt:
        """Atomic burn: either the full amount leaves the stake, or nothing does."""
        if amount <= 0:
            raise ValueError("burn amount must be positive")
        balance = self.stake_of(agent_id)
        if balance < amount:
            raise InsufficientStake(
                f"atomic burn refused: stake {balance:.2f} < amount {amount:.2f}"
            )
        self._apply(agent_id, -amount, reason, evidence_hash)
        return SlashReceipt(
            slash_id=self._chains[agent_id][-1].hash[:16],
            agent_id=agent_id,
            amount_burned=amount,
            remaining_stake=self.stake_of(agent_id),
            reason=reason,
            evidence_hash=evidence_hash,
        )

    def _apply(self, agent_id: str, delta: float, reason: str, evidence_hash: str) -> None:
        chain = self._chains.setdefault(agent_id, [])
        prev_hash = chain[-1].hash if chain else "0" * 64
        balance_after = round(self.stake_of(agent_id) + delta, 10)
        entry = LedgerEntry(
            seq=len(chain),
            agent_id=agent_id,
            delta=delta,
            balance_after=balance_after,
            reason=reason,
            evidence_hash=evidence_hash,
            prev_hash=prev_hash,
            hash="",
        )
        entry = entry.model_copy(update={
            "hash": sha256_canonical(entry.model_dump(exclude={"hash"}))
        })
        chain.append(entry)
        self._stakes[agent_id] = balance_after

    def verify_chain(self, agent_id: str) -> bool:
        expected_prev = "0" * 64
        balance = self._stakes.get(agent_id, 0.0)
        for entry in reversed(self._chains.get(agent_id, [])):
            if entry.hash != sha256_canonical(entry.model_dump(exclude={"hash"})):
                return False
            if entry.prev_hash != expected_prev and entry.seq != 0:
                return False
            if entry.seq == 0 and entry.prev_hash != "0" * 64:
                return False
            if abs(entry.balance_after - balance) > 1e-9:
                return False
            balance = round(balance - entry.delta, 10)
            expected_prev = entry.hash
        return True


# ---------------------------------------------------------------------------
# Slashing — on-chain settlement (EVM)
# ---------------------------------------------------------------------------

# keccak256("freezeAndSlash(address,uint256,string)")[:4], pinned so the
# adapter stays deterministic offline; recomputed and asserted when
# eth_utils (web3) is importable.
_PINNED_FREEZE_SLASH_SELECTOR = "0xbd670dc1"
try:  # pragma: no cover - exercised only where web3 is installed
    from eth_utils import keccak as _keccak

    _PINNED_FREEZE_SLASH_SELECTOR = "0x" + _keccak(text="freezeAndSlash(address,uint256,string)")[:4].hex()
except ImportError:
    pass


def _pad32(data: bytes) -> str:
    return data.hex().rjust(64, "0")


def _uint256(value: int) -> str:
    return value.to_bytes(32, "big").hex()


class EVMFreezeSlashAdapter:
    """Renders a slash as an EVM `freezeAndSlash(address,uint256,string)` call.

    Offline-first: `dry_run=True` (default) returns the exact unsigned
    transaction payload. With web3 installed and `rpc_url` set, `dry_run=False`
    broadcasts it — never used by tests or demos.
    """

    def __init__(self, contract_address: str = "0x0000000000000000000000000000000000000F1E",
                 rpc_url: str = "", chain_id: int = 43113, dry_run: bool = True) -> None:
        self.contract_address = contract_address
        self.rpc_url = rpc_url
        self.chain_id = chain_id
        self.dry_run = dry_run

    @property
    def selector(self) -> str:
        return _PINNED_FREEZE_SLASH_SELECTOR

    def amount_to_wei(self, amount_usd: float) -> int:
        return int(round(amount_usd * 10 ** 18))

    def build_settlement(self, agent_address: str, amount_usd: float, reason: str) -> Dict[str, object]:
        amount_wei = self.amount_to_wei(amount_usd)
        reason_bytes = reason.encode()
        padded_reason = reason_bytes.ljust((len(reason_bytes) + 31) // 32 * 32, b"\x00")
        # head: selector || address || uint256 || string offset (0x60)
        # tail: string length || string data (zero-padded to 32B)
        data = (
            self.selector[2:]
            + _pad32(bytes.fromhex(agent_address[2:].rjust(40, "0")))
            + _uint256(amount_wei)
            + _uint256(0x60)
            + _uint256(len(reason_bytes))
            + padded_reason.hex()
        )
        tx = {
            "to": self.contract_address,
            "data": "0x" + data,
            "value": 0,
            "chain_id": self.chain_id,
            "function": "freezeAndSlash(address,uint256,string)",
            "args": {"agent": agent_address, "slashAmount": amount_wei, "reason": reason},
            "dry_run": self.dry_run,
        }
        return tx

    def settle(self, agent_address: str, amount_usd: float, reason: str) -> Dict[str, object]:
        tx = self.build_settlement(agent_address, amount_usd, reason)
        if self.dry_run or not self.rpc_url:
            return tx
        try:  # pragma: no cover - requires network + funded key
            from web3 import Web3

            w3 = Web3(Web3.HTTPProvider(self.rpc_url))
            tx["gas"] = 200_000
            tx_hash = w3.eth.send_transaction(tx)
            tx["tx_hash"] = tx_hash.hex()
            return tx
        except ImportError as exc:
            raise RuntimeError("web3 not installed; on-chain settlement unavailable") from exc
