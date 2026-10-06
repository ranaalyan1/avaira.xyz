import hashlib
import hmac
import logging
from typing import List, Dict, Any
from pydantic import BaseModel
from cryptography.hazmat.primitives.asymmetric import ed25519

from .secret_store import get_or_create_secret

logger = logging.getLogger(__name__)


class WitnessSignature(BaseModel):
    witness_id: str
    witness_name: str
    signature: str
    timestamp: str


class WitnessNetwork:
    """
    Simulates a decentralized network of neutral witnesses (regulators, universities).
    Used to co-sign agent audit trail anchor points.

    Security note: witness keys are derived from ``AVAIRA_WITNESS_SEED`` (or a
    per-installation secret generated on first use). They used to be derived from
    ``sha256(witness_id)`` — a public value — so anyone could reproduce the private
    keys and forge a unanimous quorum. ``simulated`` is True when the seed is not
    supplied through the environment: the signatures are then only as trustworthy as
    this server, and callers must not present them as an independent quorum.
    """

    def __init__(self, seed: str | None = None):
        if seed is not None:
            self.seed = seed
            self.simulated = True
        else:
            self.seed, source = get_or_create_secret(
                "AVAIRA_WITNESS_SEED", "witness_seed", allow_ephemeral=True
            )
            # Only an operator-provided seed makes the quorum independent of this process.
            self.simulated = source != "env"

        self.witnesses = [
            {"id": "did:avaira:witness:mit", "name": "MIT CSAIL Trust Lab"},
            {"id": "did:avaira:witness:finra", "name": "Financial Integrity Monitor"},
            {"id": "did:avaira:witness:standard", "name": "Open Accountability Foundation"},
        ]
        self.witness_keys = {
            w["id"]: ed25519.Ed25519PrivateKey.from_private_bytes(
                hmac.new(self.seed.encode(), w["id"].encode(), hashlib.sha256).digest()
            )
            for w in self.witnesses
        }

    async def co_sign_anchor(self, merkle_root: str, timestamp: str) -> List[WitnessSignature]:
        """
        Request signatures from a quorum of witnesses for a Merkle root.
        """
        signatures = []
        # In a real system, this would be an async p2p broadcast / RPC call.
        for w in self.witnesses:
            sk = self.witness_keys[w["id"]]
            payload = f"{merkle_root}|{timestamp}".encode()
            sig = sk.sign(payload).hex()
            signatures.append(WitnessSignature(
                witness_id=w["id"],
                witness_name=w["name"],
                signature=sig,
                timestamp=timestamp
            ))
        return signatures

    def verify_witness_signature(self, merkle_root: str, timestamp: str, witness_sig: WitnessSignature) -> bool:
        try:
            sk = self.witness_keys.get(witness_sig.witness_id)
            if not sk: return False
            pk = sk.public_key()
            payload = f"{merkle_root}|{timestamp}".encode()
            pk.verify(bytes.fromhex(witness_sig.signature), payload)
            return True
        except Exception:
            return False
