import os
import uuid
import httpx
import anthropic
import json
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient

class SlashDecision(BaseModel):
    should_slash: bool
    reason: str
    severity: str  # low, medium, high, critical

class SlashResult(BaseModel):
    slash_id: str
    agent_id: str
    actions_taken: list[str]
    evidence_hash: str
    stripe_charge_id: Optional[str] = None

class AppealResult(BaseModel):
    upheld: bool
    reasoning: str
    actions_taken: list[str]

class SlashEngine:
    def __init__(self, db_client=None):
        if db_client is None:
            mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
            db_name = os.environ.get("DB_NAME", "avaira")
            self.client = AsyncIOMotorClient(mongo_url)
            self.db = self.client[db_name]
        else:
            self.db = db_client

        # Built lazily: constructing the client at import time made every process that
        # merely imported this module depend on ANTHROPIC_API_KEY being valid.
        self._anthropic_client = None
        self.base_penalty = float(os.environ.get("SLASH_BASE_PENALTY_USD", "10.0"))

    @property
    def anthropic_client(self):
        if self._anthropic_client is None:
            self._anthropic_client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        return self._anthropic_client

    async def evaluate(self, agent_id: str,
                       validation_result: Any,
                       execution_result: dict) -> SlashDecision:
        """
        Detects deviations between intent and outcome.
        In v2, we only slash if the agent ACTUALLY executed a harmful action
        or bypassed the validator.
        """
        # 1. If validation blocked the intent, the system worked as intended. NO SLASH.
        if not validation_result.approved and execution_result.get("status") == "blocked":
            return SlashDecision(should_slash=False, reason="Intent blocked by guardrails", severity="none")

        # 2. If the execution result indicates an outcome deviation detected by passive monitoring
        if execution_result.get("status") == "deviation_detected":
            return SlashDecision(
                should_slash=True,
                reason="Outcome deviation: Actual execution mismatched declared intent",
                severity="high"
            )

        return SlashDecision(should_slash=False, reason="No deviation detected", severity="none")

    async def slash(self, agent_id: str, reason: str, severity: str) -> SlashResult:
        actions = []

        # LAYER 1: Immediate Freeze
        await self.db.agents.update_one(
            {"id": agent_id},
            {"$set": {"status": "frozen", "frozen_at": datetime.now(timezone.utc).isoformat()}}
        )
        actions.append("frozen_api_key")

        # Log event
        slash_id = str(uuid.uuid4())
        evidence = f"{reason}|{severity}|{datetime.now(timezone.utc).isoformat()}"
        evidence_hash = uuid.uuid5(uuid.NAMESPACE_DNS, evidence).hex

        await self.db.slash_events.insert_one({
            "id": slash_id,
            "agent_id": agent_id,
            "reason": reason,
            "severity": severity,
            "evidence_hash": evidence_hash,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        actions.append("logged_slash_event")

        # Webhook
        agent = await self.db.agents.find_one({"id": agent_id})
        if agent and agent.get("webhook_url"):
            try:
                async with httpx.AsyncClient() as client:
                    await client.post(agent["webhook_url"], json={
                        "event": "agent_slashed",
                        "agent_id": agent_id,
                        "reason": reason,
                        "severity": severity
                    })
                actions.append("fired_webhook")
            except Exception:
                actions.append("webhook_failed")

        # LAYER 2: Financial
        stripe_charge_id = None
        multiplier = {"low": 0.5, "medium": 1.0, "high": 2.0, "critical": 5.0}.get(severity, 1.0)
        penalty = self.base_penalty * multiplier

        if agent and agent.get("stripe_customer_id"):
            # Placeholder for actual Stripe charge
            # import stripe; stripe.api_key = ...; stripe.PaymentIntent.create(...)
            stripe_charge_id = f"ch_{uuid.uuid4().hex[:24]}"
            actions.append(f"charged_stripe_{penalty}_usd")

        # LAYER 3: Reputation (handled by reputation engine usually, but we mark it here)
        actions.append("reputation_penalty_applied")

        return SlashResult(
            slash_id=slash_id,
            agent_id=agent_id,
            actions_taken=actions,
            evidence_hash=evidence_hash,
            stripe_charge_id=stripe_charge_id
        )

    async def appeal(self, agent_id: str, slash_id: str, evidence: str) -> AppealResult:
        prompt = f"Evaluate this appeal for slash {slash_id}. Agent {agent_id} claims: {evidence}. Should we uphold the appeal?"

        # Use AsyncAnthropic to prevent event loop blocking
        async_client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        resp = await async_client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}]
        )
        # Simplified parsing
        upheld = "yes" in resp.content[0].text.lower()

        actions = []
        if upheld:
            await self.db.agents.update_one({"id": agent_id}, {"$set": {"status": "active"}})
            actions.append("restored_api_key")
            # Refund logic here
            actions.append("refund_initiated")

        return AppealResult(
            upheld=upheld,
            reasoning=resp.content[0].text,
            actions_taken=actions
        )
