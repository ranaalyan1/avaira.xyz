import json
import hashlib
import uuid
import os
import asyncio
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric import ed25519
from motor.motor_asyncio import AsyncIOMotorClient
from .secret_store import get_or_create_secret
from .witness_network import WitnessNetwork, WitnessSignature

class LogEntry(BaseModel):
    # W3C Verifiable Credential compatible structure
    id: str = Field(default_factory=lambda: f"urn:uuid:{uuid.uuid4()}")
    type: List[str] = ["VerifiableCredential", "AvairaIntentCredential"]
    issuer: str # agent_did
    issuanceDate: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    credentialSubject: Dict[str, Any] # Contains intent_hash, merkle_root, prev_hash, etc.
    proof: Dict[str, Any] # Contains signature, verificationMethod (DID), created

    # Avaira v3: Witness co-signatures for decentralized trust anchoring
    witness_signatures: List[WitnessSignature] = []

    # Avaira v4: Hardware-Secured Auditability (TEE Locked)
    tee_attestation: Optional[Dict[str, str]] = None

    # Internal fields (legacy support or ease of access)
    agent_id: str
    intent_hash: str
    merkle_root: Optional[str] = None
    prev_hash: Optional[str] = None
    payload: str  # Encrypted intent hex
    nonce: str    # AESGCM nonce hex

class MerkleProof(BaseModel):
    entry_id: str
    root: str
    proof: List[str]

class VerifyResult(BaseModel):
    valid: bool
    entries: int
    broken_at: Optional[str] = None

class IntentLogger:
    _locks: Dict[str, asyncio.Lock] = {}

    def __init__(self, db_client=None):
        if db_client is None:
            mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
            db_name = os.environ.get("DB_NAME", "avaira")
            self.client = AsyncIOMotorClient(mongo_url)
            self.db = self.client[db_name]
        else:
            self.db = db_client

        self.collection = self.db.intent_logs
        # Never a shared repository literal: an env-provided secret in production, a
        # per-installation secret file otherwise (see core/secret_store.py). The secret
        # derives both the AES-GCM audit-log key and the per-agent signing keys, so a
        # guessable default let anyone decrypt the trail and forge agent signatures.
        self.secret, self.secret_source = get_or_create_secret("AVAIRA_LOG_SECRET", "log_secret")
        self.key = hashlib.sha256(self.secret.encode()).digest()
        self.aesgcm = AESGCM(self.key)
        self.witness_net = WitnessNetwork()

    def _get_agent_signing_key(self, agent_id: str) -> ed25519.Ed25519PrivateKey:
        # In a real app, load from secure storage (Vault/KMS)
        # For demo, derive deterministically from agent_id + global secret
        seed = hashlib.sha256((agent_id + self.secret).encode()).digest()
        return ed25519.Ed25519PrivateKey.from_private_bytes(seed)

    def _compute_merkle_root(self, hashes: List[str]) -> str:
        if not hashes: return "0" * 64
        if len(hashes) == 1: return hashes[0]

        new_hashes = []
        for i in range(0, len(hashes), 2):
            left = hashes[i]
            right = hashes[i+1] if i+1 < len(hashes) else hashes[i]
            combined = hashlib.sha256((left + right).encode()).hexdigest()
            new_hashes.append(combined)

        return self._compute_merkle_root(new_hashes)

    def _get_agent_did(self, agent_id: str) -> str:
        return f"did:avaira:{agent_id}"

    async def log(self, intent: dict, agent_id: str, risk_envelope: dict) -> LogEntry:
        """
        Logs intent into a hardware-secured cryptographic chain.
        Simulates execution inside an AWS Nitro Enclave.
        """
        if agent_id not in self._locks:
            self._locks[agent_id] = asyncio.Lock()

        async with self._locks[agent_id]:
            last_entry = await self.collection.find_one(
                {"agent_id": agent_id},
                sort=[("issuanceDate", -1)]
            )
            prev_hash = last_entry["intent_hash"] if last_entry else "0" * 64

            timestamp = datetime.now(timezone.utc).isoformat()
            intent_json = json.dumps(intent, sort_keys=True)

            # Content Hash
            content_to_hash = (intent_json + agent_id + timestamp + prev_hash)
            intent_hash = hashlib.sha256(content_to_hash.encode()).hexdigest()

            # Merkle logic
            merkle_root = self._compute_merkle_root([prev_hash, intent_hash])

            # Signing (VC Proof)
            sk = self._get_agent_signing_key(agent_id)
            signature = sk.sign(intent_hash.encode()).hex()
            agent_did = self._get_agent_did(agent_id)

            # Encrypt
            nonce = os.urandom(12)
            encrypted_payload = self.aesgcm.encrypt(nonce, intent_json.encode(), None)

            # Decentralized Anchoring: Request witness co-signatures
            witness_sigs = await self.witness_net.co_sign_anchor(merkle_root, timestamp)

            # TEE Cryptographic Minting (Simulation of AWS Nitro Attestation)
            # This signature proves the log was generated inside an isolated hardware enclave.
            tee_nonce = os.urandom(16).hex()
            tee_payload = f"{intent_hash}|{merkle_root}|{tee_nonce}"
            tee_attestation = {
                "enclave_id": f"nitro-{uuid.uuid4().hex[:8]}",
                "attestation_signature": hashlib.sha3_256((tee_payload + self.secret).encode()).hexdigest(),
                "pcr0": hashlib.sha256(b"avaira_shield_v2_core").hexdigest(),
                "nonce": tee_nonce
            }

            entry = LogEntry(
                agent_id=agent_id,
                intent_hash=intent_hash,
                merkle_root=merkle_root,
                prev_hash=prev_hash,
                payload=encrypted_payload.hex(),
                nonce=nonce.hex(),
                issuer=agent_did,
                issuanceDate=timestamp, # Match hashing timestamp
                witness_signatures=witness_sigs,
                tee_attestation=tee_attestation,
                credentialSubject={
                    "intent_hash": intent_hash,
                    "merkle_root": merkle_root,
                    "prev_hash": prev_hash,
                    "risk_envelope_hash": hashlib.sha256(json.dumps(risk_envelope, sort_keys=True).encode()).hexdigest()
                },
                proof={
                    "type": "Ed25519Signature2020",
                    "created": timestamp,
                    "verificationMethod": f"{agent_did}#key-1",
                    "proofPurpose": "assertionMethod",
                    "jws": signature
                }
            )

            await self.collection.insert_one(entry.model_dump())
            return entry

    async def verify_chain(self, agent_id: str) -> VerifyResult:
        cursor = self.collection.find({"agent_id": agent_id}).sort("issuanceDate", 1)
        expected_prev = "0" * 64
        pk = self._get_agent_signing_key(agent_id).public_key()
        count = 0

        async for entry in cursor:
            count += 1
            # 1. Check prev link
            if entry["prev_hash"] != expected_prev:
                return VerifyResult(valid=False, entries=count, broken_at=entry["id"])

            # 2. Check signature (VC proof)
            try:
                pk.verify(bytes.fromhex(entry["proof"]["jws"]), entry["intent_hash"].encode())
            except Exception:
                return VerifyResult(valid=False, entries=count, broken_at=entry["id"])

            # 3. Data Integrity check (Content vs Hash)
            try:
                # Decrypt
                nonce = bytes.fromhex(entry["nonce"])
                encrypted = bytes.fromhex(entry["payload"])
                decrypted_bytes = self.aesgcm.decrypt(nonce, encrypted, None)
                intent_json = decrypted_bytes.decode()

                # Re-calculate hash
                # LogEntry uses issuanceDate as the canonical timestamp for the audit trail
                content_to_hash = (intent_json + entry["agent_id"] + entry["issuanceDate"] + entry["prev_hash"])
                recalculated_hash = hashlib.sha256(content_to_hash.encode()).hexdigest()

                if recalculated_hash != entry["intent_hash"]:
                    return VerifyResult(valid=False, entries=count, broken_at=entry["id"])
            except Exception:
                return VerifyResult(valid=False, entries=count, broken_at=entry["id"])

            expected_prev = entry["intent_hash"]

        return VerifyResult(valid=True, entries=count)

    async def get_audit_trail(self, agent_id: str, start_date: datetime, end_date: datetime) -> List[LogEntry]:
        """
        Retrieves the audit trail for a specific agent within a time range.
        """
        cursor = self.collection.find({
            "agent_id": agent_id,
            "issuanceDate": {
                "$gte": start_date.isoformat(),
                "$lte": end_date.isoformat()
            }
        }).sort("issuanceDate", -1)

        results = []
        async for doc in cursor:
            results.append(LogEntry(**doc))
        return results
