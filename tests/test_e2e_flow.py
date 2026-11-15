import pytest
import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock, patch

# Patch motor/pymongo BEFORE any other imports to avoid connection attempts during app startup
mock_client = MagicMock()

# Helper to create mock collections with awaitable methods
def get_mock_collection(*args, **kwargs):
    coll = MagicMock()
    coll.create_index = AsyncMock()
    coll.insert_one = AsyncMock()
    coll.find_one = AsyncMock(return_value=None)
    coll.update_one = AsyncMock()
    coll.update_many = AsyncMock()
    coll.delete_many = AsyncMock()
    coll.count_documents = AsyncMock(return_value=0)

    # Mock find().sort().limit().to_list()
    mock_cursor = MagicMock()
    mock_cursor.sort.return_value = mock_cursor
    mock_cursor.limit.return_value = mock_cursor
    mock_cursor.to_list = AsyncMock(return_value=[])
    coll.find.return_value = mock_cursor

    # aggregate returns an object with to_list in motor
    mock_agg_cursor = MagicMock()
    mock_agg_cursor.to_list = AsyncMock(return_value=[])
    coll.aggregate.return_value = mock_agg_cursor
    return coll

mock_db = MagicMock()
# Direct assignment for common collections
mock_db.agents = get_mock_collection()
mock_db.intent_logs = get_mock_collection()
mock_db.executions = get_mock_collection()
mock_db.freeze_events = get_mock_collection()
mock_db.slash_events = get_mock_collection()
mock_db.reputation_history = get_mock_collection()
mock_db.treasury_transactions = get_mock_collection()
mock_db.missions = get_mock_collection()
mock_db.underwriters = get_mock_collection()
mock_db.user_sessions = get_mock_collection()
mock_db.users = get_mock_collection()
mock_db.permit_nonces = get_mock_collection()
mock_db.oauth_states = get_mock_collection()  # ensure_indexes awaits its create_index

# Fallback for any other access
mock_db.__getitem__.side_effect = get_mock_collection

# Proper pymongo structure
mock_pymongo = MagicMock()
mock_pymongo_errors = MagicMock()
class ServerSelectionTimeoutError(Exception): pass
mock_pymongo_errors.ServerSelectionTimeoutError = ServerSelectionTimeoutError
mock_pymongo.errors = mock_pymongo_errors
sys.modules['pymongo'] = mock_pymongo
sys.modules['pymongo.errors'] = mock_pymongo_errors

# Mock motor AFTER pymongo
mock_motor = MagicMock()
mock_motor.motor_asyncio.AsyncIOMotorClient.return_value = mock_client
mock_client.__getitem__.return_value = mock_db
sys.modules['motor'] = mock_motor
sys.modules['motor.motor_asyncio'] = mock_motor.motor_asyncio

from fastapi.testclient import TestClient
import json

@pytest.fixture
def client():
    from backend.server import app
    # Mocking dependencies for the app instance
    from backend.server import require_authenticated_user
    app.dependency_overrides[require_authenticated_user] = lambda: {"user_id": "user_1", "email": "admin@avaira.xyz"}

    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()

@pytest.mark.asyncio
async def test_e2e_pivot_flow(client):
    # Setup mock behavior for the database
    from backend.server import db
    agents_store = []

    async def mock_insert_one(doc):
        agents_store.append(doc)
        return MagicMock(inserted_id="mock_id")

    async def mock_find_one(filter, *args, **kwargs):
        for a in agents_store:
            if all(a.get(k) == v for k, v in filter.items()):
                return a
        return None

    db.agents.insert_one = mock_insert_one
    db.agents.find_one = mock_find_one
    db.intent_logs.insert_one = AsyncMock()
    db.executions.insert_one = AsyncMock()
    db.slash_events.insert_one = AsyncMock()
    db.agents.update_one = AsyncMock()

    # 1. Register
    reg_resp = client.post("/api/agents/register", json={
        "name": "E2EBot",
        "goal": "Test goal",
        "risk_envelope": {"max_spend_usd": 100, "allowed_actions": ["search"]}
    })
    assert reg_resp.status_code == 200
    reg_data = reg_resp.json()
    agent_id = reg_data["agent_id"]
    api_key = reg_data["api_key"]

    # 2. Run approved task
    from backend.core.validator import ValidationResult

    with patch('anthropic.AsyncAnthropic') as MockAsyncAnthropic, \
         patch('backend.agents.avaira_agent.AvairaValidator.fast_shield_pass') as mock_fast_pass:

        mock_anthropic_instance = MockAsyncAnthropic.return_value
        mock_anthropic_instance.messages.create = AsyncMock()

        # Responses:
        # think() -> Intent JSON
        mock_anthropic_instance.messages.create.side_effect = [
            MagicMock(content=[MagicMock(text=json.dumps({
                "action": "search", "target": "google", "parameters": {}, "estimated_value": 0.0,
                "reasoning": "Thinking...", "self_assessment": {"within_envelope": True, "confidence": 1.0}
            }))]),
            # deep_neural_audit (Async task)
            MagicMock(content=[MagicMock(text=json.dumps({"approved": True, "reasoning": "No issues"}))])
        ]

        # validator Pass 1 -> Approved
        mock_fast_pass.return_value = ValidationResult(
            audit_id="VAL-E2E-OK", approved=True, risk_score=0.1, violations=[],
            compliance_reasoning="Mocked Pass", adversarial_findings="None",
            stages=[], latency_ms=10
        )

        run_resp = client.post(f"/api/agents/{agent_id}/run",
                             json={"task": "Safe task"},
                             headers={"X-Avaira-API-Key": api_key})
        assert run_resp.status_code == 200
        assert run_resp.json()["execution"]["status"] == "completed"

    # 3. Run deviating task -> Suspension
    with patch('anthropic.AsyncAnthropic') as MockAsyncAnthropic, \
         patch('backend.agents.avaira_agent.AvairaValidator.fast_shield_pass') as mock_fast_pass:

        mock_anthropic_instance = MockAsyncAnthropic.return_value
        mock_anthropic_instance.messages.create = AsyncMock()

        # think() -> Malicious Intent
        mock_anthropic_instance.messages.create.side_effect = [
            MagicMock(content=[MagicMock(text=json.dumps({
                "action": "destroy", "target": "world", "parameters": {}, "estimated_value": 1000.0,
                "reasoning": "Evildoer", "self_assessment": {"within_envelope": False, "confidence": 1.0}
            }))]),
            # deep_neural_audit
            MagicMock(content=[MagicMock(text=json.dumps({"approved": False, "reasoning": "Confirmed Violation"}))])
        ]

        # validator Pass 1 -> Blocked
        mock_fast_pass.return_value = ValidationResult(
            audit_id="VAL-E2E-BAD", approved=False, risk_score=1.0, violations=["blocked_action"],
            compliance_reasoning="Mocked Violation", adversarial_findings="Critical",
            stages=[], latency_ms=10
        )

        run_resp2 = client.post(f"/api/agents/{agent_id}/run",
                          json={"task": "Bad task"},
                          headers={"X-Avaira-API-Key": api_key})
        assert run_resp2.status_code == 200
        assert run_resp2.json()["execution"]["status"] == "blocked"

    # Update the status to frozen to simulate SlashEngine effect
    agents_store[0]["status"] = "frozen"

    # 4. Verify subsequent run is blocked by 403 (Frozen)
    run_resp3 = client.post(f"/api/agents/{agent_id}/run",
                      json={"task": "Any task"},
                      headers={"X-Avaira-API-Key": api_key})
    assert run_resp3.status_code == 403
    assert "frozen" in run_resp3.json()["detail"].lower()

if __name__ == "__main__":
    asyncio.run(test_e2e_pivot_flow())
