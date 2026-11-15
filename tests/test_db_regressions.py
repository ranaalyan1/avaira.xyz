"""Database-backed regression tests for the 2026-11 audit findings.

Each test reproduces the attack from the audit against the real FastAPI app and an
in-memory database (mongomock-motor), and asserts the fixed behaviour. A test that
starts failing means a finding has reopened.

Requires the test-only package `mongomock-motor` (pinned in CI). Without it the module
is skipped with an explicit reason, so the gap is visible in the output.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone

import pytest

try:
    import mongomock_motor
except ImportError:
    # In CI a missing test dependency must fail the run, not silently skip the regressions.
    if os.environ.get("CI"):
        raise
    pytest.skip("mongomock-motor is required for DB regression tests", allow_module_level=True)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "avaira_test")
os.environ.setdefault("PERMIT_SECRET", "test-secret-key-avaira-1234567890abcdef")

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

WALLET_A = "0x1111111111111111111111111111111111111111"
WALLET_B = "0x2222222222222222222222222222222222222222"
TARGET = "0x4444444444444444444444444444444444444444"
EVIL_ORIGIN = {"Origin": "https://evil.example"}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    fake_db = mongomock_motor.AsyncMongoMockClient()[f"avaira_regress_{secrets.token_hex(4)}"]
    monkeypatch.setattr(server, "db", fake_db)
    # Module-level engines captured the real database handle at import time.
    for engine in (server.intent_logger, server.slash_engine, server.reputation_engine,
                   server.avaira_sentinel, server.ape_engine, server.trust_marketplace):
        monkeypatch.setattr(engine, "db", fake_db, raising=False)
    monkeypatch.setattr(server.intent_logger, "collection", fake_db.intent_logs, raising=False)
    monkeypatch.setattr(server.reputation_engine, "trust_graph", fake_db.trust_graph, raising=False)
    monkeypatch.setattr(server.permit_nonces, "collection", fake_db.permit_nonces, raising=False)
    monkeypatch.setattr(server, "ADMIN_EMAILS", {"admin@example.com"})
    server.RATE_LIMIT_STATE.clear()
    client = TestClient(server.app)  # no lifespan: no index creation or network startup

    def make_user(user_id: str, email: str) -> str:
        token = secrets.token_urlsafe(24)
        _run(fake_db.users.insert_one({"user_id": user_id, "email": email}))
        _run(fake_db.user_sessions.insert_one({
            "session_token_hash": server._hash_session_token(token),
            "user_id": user_id,
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        }))
        return token

    def as_user(token: str | None):
        client.cookies.clear()
        if token:
            client.cookies.set("session_token", token)
        return client

    class Env:
        pass

    e = Env()
    e.db = fake_db
    e.client = client
    e.make_user = make_user
    e.as_user = as_user
    return e


def _register(e, token=None, name="probe-agent"):
    e.as_user(token)
    r = e.client.post("/api/agents/register", json={
        "name": name, "goal": "probe",
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    assert r.status_code == 200, r.text
    return r.json()["agent_id"]


def _agent(e, agent_id):
    return _run(e.db.agents.find_one({"id": agent_id}, {"_id": 0}))


def _fund(e, agent_id, collateral=0.1):
    # Registration does not set collateral; the seeded demo record does. Set it explicitly.
    _run(e.db.agents.update_one({"id": agent_id}, {"$set": {"collateral_remaining": collateral}}))


# F-10: the public registry must not expose secrets or owners.
def test_public_agent_listing_exposes_no_secrets(env):
    _register(env)
    env.as_user(None)
    r = env.client.get("/api/agents")
    assert r.status_code == 200
    body = r.text
    for field in ("api_key_hash", "did_doc", "vault_card", '"user_id"'):
        assert field not in body, f"{field} leaked by the public listing"


# F-01 (root cause): anonymous agents have no shared owner value that could be claimed.
def test_anonymous_agent_has_no_owner_sentinel(env):
    agent_id = _register(env)
    assert _agent(env, agent_id)["user_id"] is None


# F-01: a signed-in user cannot take over an anonymously registered agent.
def test_signed_in_user_cannot_claim_an_anonymous_agent(env):
    agent_id = _register(env)  # anonymous: owner is the placeholder
    mallory = env.make_user("mallory", "mallory@example.com")
    env.as_user(mallory)
    r = env.client.post("/api/executions/request", json={"agent_id": agent_id, "action": "swap", "value": 1.0})
    assert r.status_code == 403
    assert _agent(env, agent_id)["user_id"] != "mallory"


# F-05: negative execution value is refused before any fee is computed.
def test_negative_execution_value_is_rejected(env):
    alice = env.make_user("alice", "alice@example.com")
    agent_id = _register(env, alice)
    env.as_user(alice)
    r = env.client.post("/api/executions/request", json={"agent_id": agent_id, "action": "swap", "value": -500.0})
    assert r.status_code == 422


# F-12: an explicit zero spend cap refuses any spend (it used to be replaced by $10).
def test_zero_spend_cap_refuses_any_spend(env):
    alice = env.make_user("alice", "alice@example.com")
    env.as_user(alice)
    r = env.client.post("/api/agents/register", json={
        "name": "zero-cap", "goal": "probe",
        "risk_envelope": {"max_spend_usd": 0, "allowed_actions": ["swap"]},
    })
    assert r.status_code == 200, r.text
    agent_id = r.json()["agent_id"]
    r = env.client.post("/api/executions/request", json={"agent_id": agent_id, "action": "swap", "value": 1.0})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected_deviation"
    assert _agent(env, agent_id)["status"] == "frozen"


# F-04: a mission target above the configured bound is refused before anything is stored.
def test_mission_target_value_is_bounded(env):
    alice = env.make_user("alice", "alice@example.com")
    agent_id = _register(env, alice)
    env.as_user(alice)
    r = env.client.post("/api/missions/create", json={
        "agent_id": agent_id, "description": "probe", "target_value": 1_000_000.0,
    })
    assert r.status_code == 422, r.text
    assert _run(env.db.missions.count_documents({})) == 0


# F-03: insuring an agent needs ownership of both the agent and the underwriter.
def test_insurance_needs_ownership_of_agent_and_underwriter(env):
    alice = env.make_user("alice", "alice@example.com")
    mallory = env.make_user("mallory", "mallory@example.com")
    agent_id = _register(env, alice)
    env.as_user(mallory)
    uw = env.client.post("/api/underwriters/register", json={"name": "mallory-uw", "capital_amount": 5.0})
    assert uw.status_code == 200, uw.text
    uw_id = uw.json()["id"]
    env.as_user(alice)
    r = env.client.post("/api/marketplace/insurance", json={
        "agent_id": agent_id, "underwriter_id": uw_id, "coverage_amount": 1.0,
    })
    assert r.status_code == 403, r.text


# SECURITY.md claim: an anonymous agent acts only with its own API key; the owner acts via session.
def test_anonymous_agent_needs_its_key_and_owner_session_works(env):
    env.as_user(None)
    reg = env.client.post("/api/agents/register", json={
        "name": "anon", "goal": "probe",
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    assert reg.status_code == 200, reg.text
    agent_id, api_key = reg.json()["agent_id"], reg.json()["api_key"]
    body = {"agent_id": agent_id, "action": "swap", "value": 1.0}
    assert env.client.post("/api/executions/request", json=body).status_code == 401
    assert env.client.post("/api/missions/create", json={
        "agent_id": agent_id, "description": "probe", "target_value": 10.0,
    }).status_code == 401
    keyed = env.client.post("/api/executions/request", json=body, headers={"X-Avaira-API-Key": api_key})
    assert keyed.status_code == 200, keyed.text
    # Owner session path: a signed-in owner acts on an agent they own.
    alice = env.make_user("alice", "alice@example.com")
    owned = _register(env, alice)
    env.as_user(alice)
    assert env.client.post("/api/executions/request", json={**body, "agent_id": owned}).status_code == 200


# F-02: freezing an agent holds: a frozen agent gets no new permit and stays frozen.
def test_frozen_agent_cannot_be_reactivated_by_a_lifecycle_run(env):
    alice = env.make_user("alice", "alice@example.com")
    admin = env.make_user("admin-user", "admin@example.com")
    env.as_user(alice)
    first = env.client.post("/api/agent/simulate-full-lifecycle", json={
        "agent_address": WALLET_A, "mission_goal": "probe",
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    assert first.status_code != 403, first.text
    agent = _run(env.db.agents.find_one({"wallet_address": WALLET_A}, {"_id": 0}))
    assert agent is not None
    env.as_user(admin)
    frozen = env.client.post(f"/api/freeze/{agent['id']}", json={"reason": "audit probe"})
    assert frozen.status_code == 200, frozen.text
    env.as_user(alice)
    again = env.client.post("/api/agent/simulate-full-lifecycle", json={
        "agent_address": WALLET_A, "mission_goal": "probe",
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    assert again.status_code == 403
    assert _agent(env, agent["id"])["status"] == "frozen"


# F-06: a signed-in non-owner cannot run the planner against someone else's agent.
def test_non_owner_cannot_run_agent_think(env):
    alice = env.make_user("alice", "alice@example.com")
    mallory = env.make_user("mallory", "mallory@example.com")
    env.as_user(alice)
    env.client.post("/api/agent/simulate-full-lifecycle", json={
        "agent_address": WALLET_A, "mission_goal": "probe",
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    env.as_user(mallory)
    r = env.client.post("/api/agent/think", json={
        "agent_address": WALLET_A, "mission_goal": "probe",
        "risk_envelope": {"allowed_actions": ["swap"]},
    })
    assert r.status_code == 403


# F-07: a body-less cross-site settle with a foreign Origin is refused and changes nothing.
def test_cross_site_settle_is_refused_and_leaves_mission_open(env):
    alice = env.make_user("alice", "alice@example.com")
    admin = env.make_user("admin-user", "admin@example.com")
    agent_id = _register(env, alice)
    env.as_user(alice)
    m = env.client.post("/api/missions/create", json={
        "agent_id": agent_id, "description": "probe", "target_value": 100.0,
    })
    assert m.status_code == 200, m.text
    mission_id = m.json().get("id") or m.json().get("mission_id")
    env.as_user(admin)
    r = env.client.post(f"/api/missions/{mission_id}/settle?success=true", headers=EVIL_ORIGIN)
    assert r.status_code == 403
    mission = _run(env.db.missions.find_one({"id": mission_id}, {"_id": 0}))
    assert mission["status"] == "open"


# F-08: a single admin slash debits collateral once; the response matches the stored value.
def test_slash_debits_collateral_once(env):
    alice = env.make_user("alice", "alice@example.com")
    admin = env.make_user("admin-user", "admin@example.com")
    agent_id = _register(env, alice)
    _fund(env, agent_id, 0.1)
    env.as_user(admin)
    r = env.client.post(f"/api/slash/{agent_id}", json={"reason": "probe", "amount": 0.05})
    assert r.status_code == 200, r.text
    stored = _agent(env, agent_id)["collateral_remaining"]
    assert round(r.json()["collateral_remaining"], 6) == round(stored, 6)
    assert round(stored, 6) == 0.05


# Ordering: the admin-key slash route debits collateral only after the engine has acted.
# If the engine fails, the balance must be untouched (it used to be debited first).
def test_failed_engine_slash_leaves_collateral_intact(env, monkeypatch):
    alice = env.make_user("alice", "alice@example.com")
    agent_id = _register(env, alice)
    _fund(env, agent_id, 0.1)
    monkeypatch.setattr(server, "AVAIRA_ADMIN_KEY", "k" * 40)

    async def boom(*args, **kwargs):
        raise RuntimeError("engine unavailable")

    monkeypatch.setattr(server.slash_engine, "slash", boom)
    env.as_user(None)
    with pytest.raises(RuntimeError):
        env.client.post(f"/api/agents/{agent_id}/slash", json={"reason": "probe"},
                        headers={"X-Avaira-Admin-Key": "k" * 40})
    assert _agent(env, agent_id)["collateral_remaining"] == 0.1


# F-09: a negative slash amount is refused (it used to raise collateral).
def test_negative_slash_amount_is_rejected(env):
    alice = env.make_user("alice", "alice@example.com")
    admin = env.make_user("admin-user", "admin@example.com")
    agent_id = _register(env, alice)
    _fund(env, agent_id, 0.1)
    env.as_user(admin)
    before = _agent(env, agent_id)["collateral_remaining"]
    r = env.client.post(f"/api/slash/{agent_id}", json={"reason": "probe", "amount": -0.5})
    assert r.status_code == 422
    assert _agent(env, agent_id)["collateral_remaining"] == before


# F-13: anchor-state must not claim anchoring.
def test_anchor_state_does_not_claim_anchoring(env):
    r = env.client.get("/api/anchor-state")
    assert r.status_code == 501
    assert r.json()["anchored"] is False


# F-16: /api/validate returns a result instead of a 500.
def test_validate_endpoint_does_not_500(env):
    r = env.client.post("/api/validate", json={
        "intent": {"action": "swap", "value": 1.0},
        "risk_envelope": {"max_spend_usd": 10.0, "allowed_actions": ["swap"]},
    })
    assert r.status_code == 200, r.text
