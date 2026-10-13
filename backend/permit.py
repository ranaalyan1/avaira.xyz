from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils.address import to_checksum_address
from eth_utils.crypto import keccak

logger = logging.getLogger(__name__)

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def _secret_to_private_key(secret: str) -> str:
    normalized = secret.strip()
    if not normalized:
        raise RuntimeError("PERMIT_SECRET is not configured")
    if normalized.startswith("0x") and len(normalized) == 66:
        return normalized
    return f"0x{keccak(text=normalized).hex()}"


def _signing_private_key() -> str:
    explicit = os.environ.get("PERMIT_PRIVATE_KEY", "").strip()
    if explicit.startswith("0x") and len(explicit) == 66:
        return explicit

    protocol_key = os.environ.get("PROTOCOL_PRIVATE_KEY", "").strip()
    if protocol_key.startswith("0x") and len(protocol_key) == 66:
        return protocol_key

    return _secret_to_private_key(os.environ.get("PERMIT_SECRET", ""))


def _permit_signer():
    return Account.from_key(_signing_private_key())


def _value_to_wei(value: float | int | str | Decimal) -> int:
    decimal_value = Decimal(str(value))
    return int(decimal_value * Decimal(10**18))


def _typed_data(agent_address: str, action: str, target: str, value_wei: int, nonce: int, deadline: int, chain_id: int) -> Dict[str, Any]:
    verifying_contract = os.environ.get("EXECUTION_WALLET_ADDRESS", ZERO_ADDRESS) or ZERO_ADDRESS
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "ExecutionPermit": [
                {"name": "agent", "type": "address"},
                {"name": "action", "type": "string"},
                {"name": "target", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
            ],
        },
        "primaryType": "ExecutionPermit",
        "domain": {
            "name": "AvairaProtocol",
            "version": "1",
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(verifying_contract),
        },
        "message": {
            "agent": to_checksum_address(agent_address),
            "action": action,
            "target": to_checksum_address(target),
            "value": value_wei,
            "nonce": nonce,
            "deadline": deadline,
        },
    }


def generate_permit(agent_address: str, action: str, target: str, value: float | int | str, nonce: int, chain_id: int = 43113) -> Dict[str, Any]:
    deadline = int((datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp())
    typed_data = _typed_data(agent_address, action, target, _value_to_wei(value), nonce, deadline, chain_id)
    signable = encode_typed_data(full_message=typed_data)
    signed = Account.sign_message(signable, _signing_private_key())
    return {
        "permit": typed_data["message"],
        "signature": signed.signature.hex(),
        "deadline": deadline,
        "signer": _permit_signer().address,
        "typed_data": typed_data,
    }


def verify_permit(
    permit: Dict[str, Any],
    signature: str,
    agent_address: str,
    *,
    now: int | None = None,
) -> bool:
    """Verify an execution permit against the protocol signer.

    Rules enforced here (all of them were previously missing or too weak):

    * the signature must be produced by the *protocol* signer — accepting the agent's
      own address as a valid signer made every agent able to self-issue permits, which
      defeats the point of the protocol co-signing an execution;
    * the permit must be scoped to ``agent_address`` (otherwise a permit signed for
      agent A authorises agent B);
    * the permit's ``deadline`` must still be in the future (expired permits were
      accepted forever);
    * malformed input is rejected, not raised — this is a verifier that may be fed
      hostile payloads.

    Replay protection is intentionally *not* implemented here (it needs storage):
    callers must consume ``permit["nonce"]`` once via :class:`PermitNonceRegistry`.
    """
    try:
        if not signature or not permit:
            return False

        permit_agent = to_checksum_address(permit["agent"])
        if permit_agent.lower() != to_checksum_address(agent_address).lower():
            return False

        deadline = int(permit["deadline"])
        if deadline <= int(time.time() if now is None else now):
            return False

        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "ExecutionPermit": [
                    {"name": "agent", "type": "address"},
                    {"name": "action", "type": "string"},
                    {"name": "target", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "deadline", "type": "uint256"},
                ],
            },
            "primaryType": "ExecutionPermit",
            "domain": {
                "name": "AvairaProtocol",
                "version": "1",
                "chainId": int(permit.get("chainId", 43113) or 43113),
                "verifyingContract": to_checksum_address(permit.get("verifyingContract") or os.environ.get("EXECUTION_WALLET_ADDRESS", ZERO_ADDRESS) or ZERO_ADDRESS),
            },
            "message": {
                "agent": permit_agent,
                "action": permit["action"],
                "target": to_checksum_address(permit["target"]),
                "value": int(permit["value"]),
                "nonce": int(permit["nonce"]),
                "deadline": deadline,
            },
        }
        signable = encode_typed_data(full_message=typed_data)
        recovered = Account.recover_message(signable, signature=signature)
    except Exception as exc:  # malformed permit, bad signature hex, unknown address…
        logger.warning("permit verification rejected malformed input: %s", exc)
        return False

    expected_signer = _permit_signer().address
    return recovered.lower() == expected_signer.lower()


class PermitNonceRegistry:
    """Single-use nonce bookkeeping for execution permits.

    Backed by a unique ``(agent_id, nonce)`` index on ``db.permit_nonces``: the insert
    either wins (permit may execute) or trips the duplicate-key error (replay). The
    previous code created a unique index on ``agent_id`` alone and never queried it, so
    a captured permit could be replayed indefinitely.
    """

    def __init__(self, collection):
        self.collection = collection

    async def consume(self, agent_address: str, nonce: int) -> bool:
        """Atomically mark ``(agent, nonce)`` as used. False means it was already used."""
        from pymongo.errors import DuplicateKeyError

        document = {
            "agent_id": to_checksum_address(agent_address).lower(),
            "nonce": int(nonce),
            "used_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            await self.collection.insert_one(document)
            return True
        except DuplicateKeyError:
            return False
