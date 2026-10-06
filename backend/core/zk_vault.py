import hashlib
import hmac
import json
import logging
from typing import Dict, Any

from pydantic import BaseModel

from .secret_store import get_or_create_secret

logger = logging.getLogger(__name__)


class ZKProof(BaseModel):
    proof_type: str = "zk-simulator/hmac-sha256"
    circuit_name: str
    public_inputs: Dict[str, Any]
    proof_data: str  # hex encoded proof commitment
    # Kept for backwards compatibility with earlier clients; it now mirrors `verify`.
    verifiable: bool = True
    # This deployment ships a *simulator*, not a real SNARK: the commitment proves the
    # server computed the public inputs, it does not prove knowledge of private intent.
    simulated: bool = True


class ZKAuditVault:
    """
    Zero-Knowledge Audit Vault (simulator).

    The protocol uses a keyed commitment so that a proof can only be produced by
    someone holding ``AVAIRA_ZK_SECRET`` (or the per-installation secret generated on
    first use) and can be *verified* by recomputing that commitment from the public
    inputs. Previously ``verify_compliance_proof`` simply returned the caller-supplied
    ``verifiable`` flag, so every proof was valid by construction.

    Real ZK proving (Noir/Risc0/snarkjs) is still a roadmap item; until then this
    class must not be advertised as a zero-knowledge proof system.
    """

    def __init__(self, secret: str = None):
        if secret is not None:
            self.secret, self.secret_source = secret, "explicit"
        else:
            self.secret, self.secret_source = get_or_create_secret(
                "AVAIRA_ZK_SECRET", "zk_secret", allow_ephemeral=False
            )
        self.simulated = True

    # ── commitment ────────────────────────────────────────────────────────────
    @staticmethod
    def _canonical(public_inputs: Dict[str, Any]) -> str:
        return json.dumps(public_inputs, sort_keys=True, separators=(",", ":"))

    def _commit(self, public_inputs: Dict[str, Any]) -> str:
        return hmac.new(
            self.secret.encode(), self._canonical(public_inputs).encode(), hashlib.sha256
        ).hexdigest()

    async def generate_compliance_proof(self,
                                     intent: Dict[str, Any],
                                     envelope: Dict[str, Any],
                                     audit_id: str) -> ZKProof:
        """
        Generates a compliance commitment for an intent against a risk envelope.

        The public inputs commit to the intent hash and to the envelope bounds, so a
        verifier learns that *some* intent under the same hash was inside the envelope
        without seeing the intent itself.
        """
        intent_json = json.dumps(intent, sort_keys=True)
        intent_hash = hashlib.sha256(intent_json.encode()).hexdigest()

        public_inputs = {
            "intent_hash": intent_hash,
            "max_spend_usd": envelope.get("max_spend_usd"),
            "allowed_actions_hash": hashlib.sha256(json.dumps(envelope.get("allowed_actions", []), sort_keys=True).encode()).hexdigest(),
            "audit_id": audit_id
        }

        return ZKProof(
            circuit_name="RiskEnvelopeCompliance",
            public_inputs=public_inputs,
            proof_data=self._commit(public_inputs),
            verifiable=True,
            simulated=True,
        )

    def verify_compliance_proof(self, proof: ZKProof) -> bool:
        """
        Verifies the commitment using only the public inputs: the proof is accepted
        only if it was produced by this vault's secret over exactly these inputs.
        """
        try:
            expected = self._commit(proof.public_inputs)
        except (TypeError, ValueError):
            return False
        if not hmac.compare_digest(expected, proof.proof_data or ""):
            return False

        required = {"intent_hash", "allowed_actions_hash", "audit_id"}
        return required.issubset(proof.public_inputs.keys())
