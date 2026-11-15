import uuid
import os
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient

class InsurancePolicy(BaseModel):
    id: str
    agent_id: str
    underwriter_id: str
    coverage_amount_usd: float
    premium_paid_usd: float
    status: str # "active", "claimed", "expired"
    created_at: str

class TrustMarketplace:
    """
    Manages Staking, Insurance, and the modular Slashing bridge.
    Connects Avaira scores to economic finality.
    """
    def __init__(self, db_client=None):
        self.db = db_client
        self.slash_rate = 0.5 # 50% default slash

    async def issue_policy(self, agent_id: str, underwriter_id: str, coverage: float) -> InsurancePolicy:
        # Calculate premium based on Avaira Score (S_A)
        agent = await self.db.agents.find_one({"id": agent_id})
        if agent is None:
            raise ValueError(f"unknown agent {agent_id}")
        score = agent.get("avaira_score", 50)

        # Higher score = lower premium. Base rate 5%
        premium_rate = max(0.01, 0.05 * (100 - score) / 50)
        premium = coverage * premium_rate

        policy = InsurancePolicy(
            id=str(uuid.uuid4()),
            agent_id=agent_id,
            underwriter_id=underwriter_id,
            coverage_amount_usd=coverage,
            premium_paid_usd=premium,
            status="active",
            created_at=datetime.now(timezone.utc).isoformat()
        )

        await self.db.insurance_policies.insert_one(policy.model_dump())
        return policy

    async def trigger_slashing_bridge(self, agent_id: str, reason: str, severity: str, slash_amount: float | None = None):
        """
        Modular bridge for on-chain slashing (simulated EigenLayer / L2 event).

        This records the economic-finality event only. It does NOT debit collateral: the
        caller (the slash route) already debited it once. The previous version debited
        again here, so a single admin slash removed collateral twice (audit F-08).
        """
        agent = await self.db.agents.find_one({"id": agent_id})
        if agent is None:
            raise ValueError(f"unknown agent {agent_id}")
        if slash_amount is None:
            collateral = agent.get("collateral_remaining", 0)
            slash_amount = collateral * (0.2 if severity == "medium" else 0.8)

        # Log bridge event (Mocking the EigenLayer/L2 transaction)
        bridge_event = {
            "id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "target_chain": "avalanche-fuji", # Or "eigenlayer-avs"
            "slash_amount": slash_amount,
            "reason": reason,
            "tx_hash": "0x" + os.urandom(32).hex(),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        await self.db.slash_bridge_logs.insert_one(bridge_event)

        return bridge_event
