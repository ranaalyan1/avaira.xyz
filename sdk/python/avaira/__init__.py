"""Avaira v2 — accountability for the agent economy, enforced on Monad.

x402 lets agents pay. ERC-8004 lets agents be identified. Avaira makes them accountable in
real time: every action is committed before it happens, gated by stake and score, and
anchored afterwards so a deviation can be proven by anyone.
"""

from .audit import AuditEntry, AuditTrail, hash_leaf, hash_pair, merkle_proof, merkle_root, verify_proof
from .client import Avaira, AvairaError, ExecutionContext
from .types import (
    AgentStatus,
    BlockedRun,
    CompletedRun,
    GateReason,
    GateTimings,
    GATE_REASON_TEXT,
    RiskEnvelope,
    RunResult,
)

__version__ = "2.0.0"

__all__ = [
    "AuditEntry",
    "AuditTrail",
    "AgentStatus",
    "Avaira",
    "AvairaError",
    "BlockedRun",
    "CompletedRun",
    "ExecutionContext",
    "GateReason",
    "GateTimings",
    "GATE_REASON_TEXT",
    "RiskEnvelope",
    "RunResult",
    "hash_leaf",
    "hash_pair",
    "merkle_proof",
    "merkle_root",
    "verify_proof",
]
