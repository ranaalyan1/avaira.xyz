"""Regression tests for the 2026-10 security audit.

Every test here corresponds to a finding that was *exploitable before the fix*: it
fails on the pre-fix code and passes afterwards. Keep them together so a future
refactor cannot silently reopen one of these holes.
"""
from __future__ import annotations

import os
import sys

import pytest
from fastapi import HTTPException
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# server.py refuses to import without these; the tests only exercise pure logic.
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "avaira_test")
os.environ.setdefault("PERMIT_SECRET", "test-secret-key-avaira-1234567890abcdef")

# ── secret_store ──────────────────────────────────────────────────────────────
from core.secret_store import MissingSecretError, get_or_create_secret  # noqa: E402


class TestSecretStore:
    def test_env_var_wins(self, monkeypatch):
        monkeypatch.setenv("AVAIRA_TEST_SECRET", "x" * 32)
        secret, source = get_or_create_secret("AVAIRA_TEST_SECRET", "nope")
        assert (secret, source) == ("x" * 32, "env")

    def test_short_env_var_is_refused(self, monkeypatch):
        monkeypatch.setenv("AVAIRA_TEST_SECRET", "short")
        with pytest.raises(MissingSecretError):
            get_or_create_secret("AVAIRA_TEST_SECRET", "nope")

    def test_generated_secret_is_persisted_and_stable(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AVAIRA_TEST_SECRET", raising=False)
        monkeypatch.setenv("AVAIRA_DATA_DIR", str(tmp_path))
        first, first_source = get_or_create_secret("AVAIRA_TEST_SECRET", "test_secret")
        second, second_source = get_or_create_secret("AVAIRA_TEST_SECRET", "test_secret")
        assert first_source == second_source == "file"
        assert first == second, "a restart must find the same secret"
        # 0600: the secret is not world-readable.
        mode = (tmp_path / "test_secret").stat().st_mode & 0o777
        assert mode == 0o600

    def test_no_shared_default_when_unwritable(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AVAIRA_TEST_SECRET", raising=False)
        # A *file* where the data directory should be makes persistence impossible.
        blocked = tmp_path / "blocked"
        blocked.write_text("not a directory")
        monkeypatch.setenv("AVAIRA_DATA_DIR", str(blocked))
        with pytest.raises(MissingSecretError):
            get_or_create_secret("AVAIRA_TEST_SECRET", "test_secret")

    def test_ephemeral_opt_in(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AVAIRA_TEST_SECRET", raising=False)
        blocked = tmp_path / "blocked"
        blocked.write_text("not a directory")
        monkeypatch.setenv("AVAIRA_DATA_DIR", str(blocked))
        secret, source = get_or_create_secret("AVAIRA_TEST_SECRET", "test_secret", allow_ephemeral=True)
        assert source == "ephemeral" and len(secret) >= 32


# ── permit.py ─────────────────────────────────────────────────────────────────
from permit import PermitNonceRegistry, generate_permit, verify_permit  # noqa: E402

AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TARGET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


@pytest.fixture(autouse=True)
def permit_env(monkeypatch):
    monkeypatch.setenv("PERMIT_SECRET", "test-secret-key-avaira-1234567890abcdef")
    monkeypatch.setenv("EXECUTION_WALLET_ADDRESS", "0x0000000000000000000000000000000000000001")


class TestPermitVerification:
    def test_protocol_signed_permit_is_accepted(self):
        result = generate_permit(AGENT, "transfer", TARGET, 0.5, 1)
        assert verify_permit(result["permit"], result["signature"], AGENT) is True

    def test_agent_self_signed_permit_is_rejected(self):
        """The agent's own address used to count as an accepted signer."""
        import eth_account
        from permit import _typed_data, _value_to_wei

        attacker = eth_account.Account.from_key("0x" + "11" * 32)
        deadline = 2**40
        typed = _typed_data(AGENT, "transfer", TARGET, _value_to_wei(1), 1, deadline, 43113)
        signable = eth_account.messages.encode_typed_data(full_message=typed)
        signature = "0x" + attacker.sign_message(signable).signature.hex()
        assert verify_permit(typed["message"], signature, AGENT) is False

    def test_permit_for_another_agent_is_rejected(self):
        result = generate_permit(AGENT, "transfer", TARGET, 0.5, 1)
        assert verify_permit(result["permit"], result["signature"], TARGET) is False

    def test_expired_permit_is_rejected(self):
        result = generate_permit(AGENT, "transfer", TARGET, 0.5, 1)
        assert verify_permit(result["permit"], result["signature"], AGENT, now=result["deadline"] + 1) is False

    @pytest.mark.parametrize("permit,signature", [({}, "0x00"), ({}, ""), ({"agent": "nope"}, "0x00")])
    def test_malformed_input_returns_false_instead_of_raising(self, permit, signature):
        assert verify_permit(permit, signature, AGENT) is False


class TestPermitNonceRegistry:
    class _Collection:
        """Mimics MongoDB's unique (agent_id, nonce) index."""

        def __init__(self):
            self.seen = set()

        async def insert_one(self, document):
            from pymongo.errors import DuplicateKeyError

            key = (document["agent_id"], document["nonce"])
            if key in self.seen:
                raise DuplicateKeyError("duplicate key")
            self.seen.add(key)

    @pytest.mark.asyncio
    async def test_a_permit_nonce_can_only_be_consumed_once(self):
        registry = PermitNonceRegistry(self._Collection())
        assert await registry.consume(AGENT, 7) is True
        assert await registry.consume(AGENT, 7) is False, "replay must be refused"
        assert await registry.consume(AGENT, 8) is True, "a fresh nonce still works"


# ── witness_network ───────────────────────────────────────────────────────────
import hashlib  # noqa: E402

from core.witness_network import WitnessNetwork, WitnessSignature  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: E402


class TestWitnessNetwork:
    @pytest.mark.asyncio
    async def test_signatures_round_trip(self):
        wn = WitnessNetwork(seed="unit-test-seed")
        sigs = await wn.co_sign_anchor("root", "ts")
        assert len(sigs) == 3
        assert all(wn.verify_witness_signature("root", "ts", s) for s in sigs)

    def test_public_witness_id_cannot_forge_a_signature(self):
        """Keys used to be sha256(witness_id) — anyone could reproduce them."""
        wn = WitnessNetwork(seed="unit-test-seed")
        forged_key = ed25519.Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"did:avaira:witness:mit").digest())
        forged = WitnessSignature(
            witness_id="did:avaira:witness:mit",
            witness_name="MIT CSAIL Trust Lab",
            signature=forged_key.sign(b"root|ts").hex(),
            timestamp="ts",
        )
        assert wn.verify_witness_signature("root", "ts", forged) is False

    def test_seed_source_is_reported(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AVAIRA_WITNESS_SEED", raising=False)
        monkeypatch.setenv("AVAIRA_DATA_DIR", str(tmp_path))
        assert WitnessNetwork().simulated is True
        monkeypatch.setenv("AVAIRA_WITNESS_SEED", "s" * 32)
        assert WitnessNetwork().simulated is False


# ── zk_vault ──────────────────────────────────────────────────────────────────
from core.zk_vault import ZKAuditVault  # noqa: E402


class TestZKProofs:
    INTENT = {"action": "research", "value": 5}
    ENVELOPE = {"max_spend_usd": 10, "allowed_actions": ["research"]}

    @pytest.mark.asyncio
    async def test_genuine_proof_verifies(self):
        vault = ZKAuditVault(secret="unit-test-zk-secret")
        proof = await vault.generate_compliance_proof(self.INTENT, self.ENVELOPE, "audit-1")
        assert vault.verify_compliance_proof(proof) is True
        assert proof.simulated is True, "must not claim to be a real SNARK"

    @pytest.mark.asyncio
    async def test_tampered_proof_is_rejected(self):
        vault = ZKAuditVault(secret="unit-test-zk-secret")
        proof = await vault.generate_compliance_proof(self.INTENT, self.ENVELOPE, "audit-1")

        forged = proof.model_copy(deep=True)
        forged.proof_data = "00" * 32  # attacker supplies a digest
        assert vault.verify_compliance_proof(forged) is False

    @pytest.mark.asyncio
    async def test_tampered_public_inputs_are_rejected(self):
        vault = ZKAuditVault(secret="unit-test-zk-secret")
        proof = await vault.generate_compliance_proof(self.INTENT, self.ENVELOPE, "audit-1")

        widened = proof.model_copy(deep=True)
        widened.public_inputs = {**proof.public_inputs, "max_spend_usd": 1_000_000}
        assert vault.verify_compliance_proof(widened) is False

    @pytest.mark.asyncio
    async def test_another_installations_secret_cannot_forge_proofs(self):
        honest = ZKAuditVault(secret="installation-a")
        attacker = ZKAuditVault(secret="installation-b")
        proof = await honest.generate_compliance_proof(self.INTENT, self.ENVELOPE, "audit-1")
        assert attacker.verify_compliance_proof(proof) is False


# ── tee_identity ──────────────────────────────────────────────────────────────
from core.tee_identity import TEEIdentityManager  # noqa: E402


class TestTEEIdentity:
    def test_attestation_round_trip(self):
        manager = TEEIdentityManager(secret="unit-test-tee-secret")
        did_doc = manager.generate_agent_did("agent-1", "pubkey-hash")
        assert manager.verify_attestation(did_doc) is True
        assert did_doc.attestation.simulated is True

    def test_tampered_measurement_is_rejected(self):
        manager = TEEIdentityManager(secret="unit-test-tee-secret")
        did_doc = manager.generate_agent_did("agent-1", "pubkey-hash")
        did_doc.attestation.pcr0 = "00" * 32
        assert manager.verify_attestation(did_doc) is False

    def test_attestation_cannot_be_minted_without_the_installation_secret(self):
        """The old code signed with a literal that ships in the repository."""
        victim = "hardware-root-of-trust-0x1337"
        assert victim not in (TEEIdentityManager(secret="installation-a").secret,)
        honest = TEEIdentityManager(secret="installation-a")
        attacker = TEEIdentityManager(secret="installation-b")
        did_doc = honest.generate_agent_did("agent-1", "pubkey-hash")
        assert attacker.verify_attestation(did_doc) is False


# ── agent_vault ───────────────────────────────────────────────────────────────
from core.agent_vault import AgentVault  # noqa: E402


class TestAgentVaultSpendWall:
    @pytest.mark.asyncio
    async def test_payment_cannot_exceed_the_cards_own_limit(self):
        vault = AgentVault()
        card = await vault.generate_virtual_card("agent-1", 25.0)
        assert (await vault.execute_payment(card.card_id, 10.0, "AWS"))["status"] == "approved"
        declined = await vault.execute_payment(card.card_id, 20.0, "AWS")
        assert declined["status"] == "declined"
        assert declined["reason"] == "insufficient_fiat_limit", "the card's limit must be the wall"

    @pytest.mark.asyncio
    async def test_merchant_whitelist_is_enforced(self):
        vault = AgentVault()
        card = await vault.generate_virtual_card("agent-1", 100.0)
        declined = await vault.execute_payment(card.card_id, 5.0, "SketchyCo")
        assert (declined["status"], declined["reason"]) == ("declined", "merchant_not_whitelisted")

    @pytest.mark.asyncio
    async def test_unknown_card_and_invalid_amounts_are_refused(self):
        vault = AgentVault()
        card = await vault.generate_virtual_card("agent-1", 100.0)
        assert (await vault.execute_payment("ic_missing", 1.0, "AWS"))["reason"] == "unknown_card"
        assert (await vault.execute_payment(card.card_id, 0, "AWS"))["reason"] == "invalid_amount"
        assert (await vault.execute_payment(card.card_id, -5, "AWS"))["reason"] == "invalid_amount"
        assert (await vault.execute_payment(card.card_id, float("nan"), "AWS"))["reason"] == "invalid_amount"

    @pytest.mark.asyncio
    async def test_spend_accumulates_across_payments(self):
        vault = AgentVault()
        card = await vault.generate_virtual_card("agent-1", 30.0)
        for _ in range(3):
            assert (await vault.execute_payment(card.card_id, 10.0, "OpenAI"))["status"] == "approved"
        assert (await vault.execute_payment(card.card_id, 0.01, "OpenAI"))["reason"] == "insufficient_fiat_limit"
        status = vault.card_status(card.card_id)
        assert status["spent_usd"] == 30.0 and status["remaining_usd"] == 0.0


# ── server authorization ──────────────────────────────────────────────────────
import server as avaira_server  # noqa: E402


def _request(headers=None):
    request = MagicMock()
    request.headers = headers or {}
    request.client = MagicMock(host="203.0.113.9")
    return request


class TestAgentAccess:
    @pytest.mark.asyncio
    async def test_anonymous_callers_are_refused(self, monkeypatch):
        """`POST /executions/request` used to be callable by anyone, letting them
        freeze any agent by posting an out-of-envelope value."""
        agent = {"id": "agent-1", "user_id": "owner-1"}

        async def no_session(_request):
            raise HTTPException(401, "no session")

        monkeypatch.setattr(avaira_server, "get_current_user", no_session)
        with pytest.raises(HTTPException) as exc:
            await avaira_server.require_agent_access(_request(), agent)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_a_non_owner_session_is_refused(self, monkeypatch):
        agent = {"id": "agent-1", "user_id": "owner-1"}

        async def other_user(_request):
            return {"user_id": "intruder"}

        monkeypatch.setattr(avaira_server, "get_current_user", other_user)
        with pytest.raises(HTTPException) as exc:
            await avaira_server.require_agent_access(_request(), agent)
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_the_owner_session_is_allowed(self, monkeypatch):
        agent = {"id": "agent-1", "user_id": "owner-1"}

        async def owner(_request):
            return {"user_id": "owner-1"}

        monkeypatch.setattr(avaira_server, "get_current_user", owner)
        assert (await avaira_server.require_agent_access(_request(), agent)) is agent

    @pytest.mark.asyncio
    async def test_an_api_key_for_a_different_agent_is_refused(self, monkeypatch):
        agent = {"id": "agent-1", "user_id": "owner-1"}
        fake_db = MagicMock()
        fake_db.agents.find_one = AsyncMock(return_value={"id": "agent-2", "user_id": "owner-2"})
        monkeypatch.setattr(avaira_server, "db", fake_db)

        with pytest.raises(HTTPException) as exc:
            await avaira_server.require_agent_access(
                _request({"X-Avaira-API-Key": "someone-elses-key"}), agent
            )
        assert exc.value.status_code == 403


class TestRateLimiting:
    @pytest.mark.asyncio
    async def test_limit_is_enforced_per_key(self):
        avaira_server.RATE_LIMIT_STATE.clear()
        request = _request()
        scope = "unit_test_scope"
        for _ in range(3):
            await avaira_server.enforce_rate_limit(request, scope, limit=3, window_seconds=60, identity="agent-x")
        with pytest.raises(HTTPException) as exc:
            await avaira_server.enforce_rate_limit(request, scope, limit=3, window_seconds=60, identity="agent-x")
        assert exc.value.status_code == 429
        # …and a different identity is unaffected.
        await avaira_server.enforce_rate_limit(request, scope, limit=3, window_seconds=60, identity="agent-y")
