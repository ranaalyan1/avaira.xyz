import hashlib
import hmac
import uuid
import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List
from pydantic import BaseModel

from .secret_store import get_or_create_secret

class TEEAttestation(BaseModel):
    enclave_id: str
    pcr0: str
    pcr1: str
    pcr2: str
    signature: str
    timestamp: str
    # This deployment simulates Nitro-style attestation locally; nothing here proves
    # that the code ran inside real hardware.
    simulated: bool = True

class AvairaDID(BaseModel):
    did: str
    controller: str
    verification_method: Dict[str, Any]
    attestation: TEEAttestation

class TEEIdentityManager:
    """
    Manages Hardware-Anchored Identities (TEE-DIDs).

    Simulates AWS Nitro Enclave attestation: the "signature" is an HMAC produced with
    ``TEE_SECRET`` (or a per-installation secret generated on first use) instead of the
    hard-coded literal this class used to ship with, so an attestation can no longer be
    minted by anyone who has read the repository. It still does not prove real hardware
    execution — ``simulated`` stays True until a genuine Nitro attestation document is
    verified against the AWS root of trust.
    """
    def __init__(self, secret: str = None):
        if secret is not None:
            self.secret, self.secret_source = secret, "explicit"
        else:
            self.secret, self.secret_source = get_or_create_secret(
                "TEE_SECRET", "tee_secret", allow_ephemeral=False
            )
        self.simulated = True

    def generate_agent_did(self, agent_id: str, public_key: str) -> AvairaDID:
        """
        Mints a new DID anchored in a hardware enclave attestation.
        """
        did = f"did:avaira:{agent_id}"
        timestamp = datetime.now(timezone.utc).isoformat()

        # Simulate PCR measurements (Hardware state measurements)
        pcr0 = hashlib.sha256(b"avaira-runtime-v2-core").hexdigest()
        pcr1 = hashlib.sha256(b"linux-kernel-nitro-5.15").hexdigest()
        pcr2 = hashlib.sha256(public_key.encode()).hexdigest()

        # Enclave Attestation Signature (keyed, unforgeable without the installation secret)
        attestation_payload = f"{did}|{pcr0}|{pcr1}|{pcr2}|{timestamp}"
        signature = self._attestation_signature(attestation_payload)

        attestation = TEEAttestation(
            enclave_id=f"nitro-{uuid.uuid4().hex[:12]}",
            pcr0=pcr0,
            pcr1=pcr1,
            pcr2=pcr2,
            signature=signature,
            timestamp=timestamp,
            simulated=True
        )

        return AvairaDID(
            did=did,
            controller=f"did:avaira:controller",
            verification_method={
                "id": f"{did}#key-1",
                "type": "Ed25519VerificationKey2020",
                "controller": did,
                "publicKeyMultibase": public_key
            },
            attestation=attestation
        )

    def _attestation_signature(self, payload: str) -> str:
        return hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    def verify_attestation(self, did_doc: AvairaDID) -> bool:
        """
        Verifies that the DID document was attested by this installation.

        Note: this proves *consistency with the installation secret*, not that the DID
        was minted inside genuine hardware. ``did_doc.attestation.simulated`` records
        that distinction for callers that need to know.
        """
        att = did_doc.attestation
        payload = f"{did_doc.did}|{att.pcr0}|{att.pcr1}|{att.pcr2}|{att.timestamp}"
        expected_sig = self._attestation_signature(payload)

        # In a real TEE, we would also verify the PCR0 measurement against a known good value
        known_pcr0 = hashlib.sha256(b"avaira-runtime-v2-core").hexdigest()

        return hmac.compare_digest(expected_sig, att.signature or "") and hmac.compare_digest(att.pcr0 or "", known_pcr0)
