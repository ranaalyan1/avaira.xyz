"""Shared types for the Avaira Python SDK.

Kept deliberately parallel to the TypeScript SDK: an agent written in Python and an agent
written in TypeScript must agree on what "blocked" means, on the byte layout of an audit
leaf, and on the reason codes the gate returns.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable


class AgentStatus(IntEnum):
    NONE = 0
    PENDING = 1
    ACTIVE = 2
    SUSPENDED = 3
    BANNED = 4


class GateReason(IntEnum):
    ALLOWED = 0
    UNKNOWN_AGENT = 1
    BANNED = 2
    SUSPENDED = 3
    STAKE_TOO_LOW = 4
    SCORE_TOO_LOW = 5
    INTENT_NOT_COMMITTED = 6
    INTENT_EXPIRED = 7
    INTENT_ALREADY_EXECUTED = 8
    ENVELOPE_MISMATCH = 9
    CVI_UNVERIFIED = 10


GATE_REASON_TEXT: dict[GateReason, str] = {
    GateReason.ALLOWED: "allowed",
    GateReason.UNKNOWN_AGENT: "unknown agent: no ERC-8004 identity for this id",
    GateReason.BANNED: "banned: terminal accountability failure",
    GateReason.SUSPENDED: "suspended: stake slashed below requirement, re-collateralise and wait out the cooldown",
    GateReason.STAKE_TOO_LOW: "stake too low: lock more USDC against the agent identity",
    GateReason.SCORE_TOO_LOW: "score too low: Avaira Score below the protocol floor",
    GateReason.INTENT_NOT_COMMITTED: "intent not committed: commit the plan hash before executing",
    GateReason.INTENT_EXPIRED: "intent expired: the risk envelope deadline has passed",
    GateReason.INTENT_ALREADY_EXECUTED: "intent already executed: one commitment = one execution",
    GateReason.ENVELOPE_MISMATCH: "envelope mismatch: the local risk envelope differs from the committed one",
    GateReason.CVI_UNVERIFIED: (
        "CVI unverified: a cva.* intent requires a valid Cleanverse wallet-bound identity "
        "credential for every involved wallet"
    ),
}


class CVIStatus(IntEnum):
    """Mirror of the onchain Cleanverse CVI credential status."""

    NONE = 0
    VALID = 1
    EXPIRED = 2
    REVOKED = 3


CVI_STATUS_TEXT: dict[CVIStatus, str] = {
    CVIStatus.NONE: "no credential: this wallet has never passed Cleanverse identity verification",
    CVIStatus.VALID: "valid: identity verified and wallet-bound",
    CVIStatus.EXPIRED: "expired: the credential must be refreshed by the issuer",
    CVIStatus.REVOKED: "revoked: the issuer withdrew this credential",
}


@dataclass
class RiskEnvelope:
    """The envelope an agent binds to a committed intent; enforced by the onchain gate."""

    max_spend_usd: int = 0
    allowed_actions: list[str] = field(default_factory=list)
    deadline: int = 0

    @property
    def as_tuple(self) -> tuple[int, list[str], int]:
        return (self.max_spend_usd, self.allowed_actions, self.deadline)


@dataclass
class GateTimings:
    """Measured latency, in milliseconds. Never estimated."""

    commit_submit_ms: float = 0.0
    gate_latency_ms: float = 0.0
    agent_gate_ms: float = 0.0
    execution_ms: float = 0.0
    attest_ms: float = 0.0
    total_ms: float = 0.0
    intent_visible: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "commitSubmitMs": self.commit_submit_ms,
            "gateLatencyMs": self.gate_latency_ms,
            "agentGateMs": self.agent_gate_ms,
            "executionMs": self.execution_ms,
            "attestMs": self.attest_ms,
            "totalMs": self.total_ms,
            "intentVisible": self.intent_visible,
        }


@dataclass
class CompletedRun:
    status: str
    agent_id: int
    intent_hash: str
    outcome_hash: str
    merkle_root: str
    score: int
    timings: GateTimings
    commit_tx_hash: str | None = None
    attest_tx_hash: str | None = None
    audit_entries: int = 0
    result: Any = None


@dataclass
class BlockedRun:
    status: str
    agent_id: int
    intent_hash: str
    score: int
    reason: GateReason
    message: str
    timings: GateTimings
    commit_tx_hash: str | None = None
    decision_tx_hash: str | None = None


RunResult = CompletedRun | BlockedRun

ExecuteFn = Callable[..., Any]
