"""Hash-chained audit trail + Merkle commitment, byte-compatible with `MerkleLib.sol`.

A leaf produced here can be handed to `AvairaIntentVault.challengeDeviation` and verified
against the root this SDK anchored. `tools/parity/compare.py` recomputes a fixed corpus
(`tools/parity/corpus.json`) with this module, with `@avaira/sdk`, and against the compiled
Solidity libraries in a local EVM, so Python, TypeScript and the chain are pinned to one
another — three independent implementations, one byte layout. Run it with `make parity`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterator

from eth_abi import encode as abi_encode
from eth_utils import keccak

ENTRY_DOMAIN = "Avaira.AuditEntry.v2"
LEAF_DOMAIN = "Avaira.DeviationLeaf.v1"
ZERO_HASH = "0x" + "00" * 32


def _hex(value: bytes) -> str:
    return "0x" + value.hex()


@dataclass
class AuditEntry:
    seq: int
    timestamp: int
    action: str
    spend_usd: int
    nonce: int
    prev_hash: str
    hash: str
    payload: Any = None


@dataclass
class AuditTrail:
    """Append-only, tamper-evident journal for one (agent, intent) pair.

    The head is published onchain as the intent's `outcomeHash`, which is why `agent_id`
    and `intent_hash` are folded into every entry hash: without that binding, identical work
    could be re-anchored under a different intent and no auditor could tell.
    """

    agent_id: int
    intent_hash: str
    entries: list[AuditEntry] = field(default_factory=list)
    _head: str = ZERO_HASH

    @property
    def head(self) -> str:
        return self._head

    @property
    def size(self) -> int:
        return len(self.entries)

    def __len__(self) -> int:
        return len(self.entries)

    def __iter__(self) -> Iterator[AuditEntry]:
        return iter(self.entries)

    def append(self, action: str, spend_usd: int = 0, payload: Any = None, nonce: int | None = None) -> AuditEntry:
        seq = len(self.entries)
        timestamp = int(time.time() * 1000)
        entry_nonce = seq if nonce is None else nonce
        digest = keccak(
            abi_encode(
                ["string", "uint256", "bytes32", "bytes32", "uint64", "string", "uint256", "uint256", "uint64"],
                [ENTRY_DOMAIN, self.agent_id, _b(self.intent_hash), _b(self._head), seq, action, spend_usd, entry_nonce, timestamp],
            )
        )
        entry = AuditEntry(
            seq=seq,
            timestamp=timestamp,
            action=action,
            spend_usd=spend_usd,
            nonce=entry_nonce,
            prev_hash=self._head,
            hash=_hex(digest),
            payload=payload,
        )
        self.entries.append(entry)
        self._head = entry.hash
        return entry

    # ── integrity ────────────────────────────────────────────────────────────────

    def verify(self) -> tuple[bool, int | None]:
        """Recomputes the chain from genesis; returns (valid, first_broken_seq)."""
        prev = ZERO_HASH
        for entry in self.entries:
            if entry.prev_hash != prev:
                return False, entry.seq
            recomputed = keccak(
                abi_encode(
                    ["string", "uint256", "bytes32", "bytes32", "uint64", "string", "uint256", "uint256", "uint64"],
                    [ENTRY_DOMAIN, self.agent_id, _b(self.intent_hash), _b(prev), entry.seq, entry.action, entry.spend_usd, entry.nonce, entry.timestamp],
                )
            )
            if _hex(recomputed) != entry.hash:
                return False, entry.seq
            prev = entry.hash
        return True, None

    # ── Merkle commitment ────────────────────────────────────────────────────────

    @staticmethod
    def leaf_for(agent_id: int, intent_hash: str, action: str, spend_usd: int, nonce: int) -> str:
        return _hex(
            keccak(
                abi_encode(
                    ["string", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
                    [LEAF_DOMAIN, agent_id, _b(intent_hash), keccak(action.encode()), spend_usd, nonce],
                )
            )
        )

    def leaves(self) -> list[str]:
        return [AuditTrail.leaf_for(self.agent_id, self.intent_hash, e.action, e.spend_usd, e.nonce) for e in self.entries]

    def merkle_root(self) -> str:
        return merkle_root(self.leaves())

    def proof_for(self, index: int) -> list[str]:
        return merkle_proof(self.leaves(), index)

    def deviations(self, envelope: RiskEnvelope | None = None, allowed_actions: list[str] | None = None, max_spend_usd: int | None = None) -> list[AuditEntry]:
        """Every entry that breaches the envelope: overspend or an action outside the allow-list."""
        max_spend = max_spend_usd if max_spend_usd is not None else (envelope.max_spend_usd if envelope else 0)
        allowed = set(allowed_actions if allowed_actions is not None else (envelope.allowed_actions if envelope else []))
        allowed.add("__none__") if not allowed else None  # empty allow-list means nothing is permitted
        return [e for e in self.entries if e.spend_usd > max_spend or e.action not in allowed]


def _b(value: str) -> bytes:
    value = value[2:] if value.startswith("0x") else value
    return bytes.fromhex(value)


def hash_leaf(value: str) -> str:
    return _hex(keccak(b"\x00" + _b(value)))


def hash_pair(a: str, b: str) -> str:
    left, right = (a, b) if a <= b else (b, a)
    return _hex(keccak(b"\x01" + _b(left) + _b(right)))


def merkle_root(leaves: list[str]) -> str:
    if not leaves:
        return ZERO_HASH
    level = [hash_leaf(leaf) for leaf in leaves]
    while len(level) > 1:
        next_level: list[str] = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                next_level.append(hash_pair(level[i], level[i + 1]))
            else:
                next_level.append(level[i])  # odd node promoted unchanged
        level = next_level
    return level[0]


def merkle_proof(leaves: list[str], index: int) -> list[str]:
    if not leaves:
        return []
    level = [hash_leaf(leaf) for leaf in leaves]
    idx = index
    proof: list[str] = []
    while len(level) > 1:
        promoted = len(level) % 2 == 1 and idx == len(level) - 1
        if not promoted:
            sibling = idx + 1 if idx % 2 == 0 else idx - 1
            if sibling < len(level):
                proof.append(level[sibling])
        next_level = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                next_level.append(hash_pair(level[i], level[i + 1]))
            else:
                next_level.append(level[i])
        level = next_level
        idx //= 2
    return proof


def verify_proof(proof: list[str], root: str, leaf: str) -> bool:
    computed = hash_leaf(leaf)
    for sibling in proof:
        computed = hash_pair(computed, sibling)
    return computed == root


# imported late to avoid a cycle with types.py
from .types import RiskEnvelope  # noqa: E402
