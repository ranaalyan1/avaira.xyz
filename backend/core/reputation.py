import os
import math
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient

class ScoreBreakdown(BaseModel):
    success_rate: float
    consistency: float
    slash_history: float
    volume_handled: float
    age_on_network: float
    appeal_win_rate: float

class AvairaScore(BaseModel):
    score: float
    grade: str
    breakdown: ScoreBreakdown

class ReputationEngine:
    def __init__(self, db_client=None):
        if db_client is None:
            mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
            db_name = os.environ.get("DB_NAME", "avaira")
            self.client = AsyncIOMotorClient(mongo_url)
            self.db = self.client[db_name]
        else:
            self.db = db_client

        # Avaira v3 Trust Graph
        self.trust_graph = self.db.trust_graph

    async def record_interaction(self, from_agent: str, to_agent: str, rating: float, evidence_hash: str):
        """
        Record a directed trust interaction between two agents.
        rating: -1.0 to 1.0
        """
        await self.trust_graph.update_one(
            {"from_agent": from_agent, "to_agent": to_agent},
            {
                "$set": {
                    "rating": rating,
                    "evidence_hash": evidence_hash,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            },
            upsert=True
        )

    async def get_subjective_reputation(self, target_agent: str, observer_agent: str) -> float:
        """
        Computes reputation of 'target' from the perspective of 'observer'
        using transitive trust (PowerIteration/EigenTrust style).
        """
        # Simplified for v3: Direct rating + average of 1st-degree neighbors
        direct = await self.trust_graph.find_one({"from_agent": observer_agent, "to_agent": target_agent})
        base_trust = direct["rating"] if direct else 0.0

        # Transitive: Who does the observer trust? And who do they trust?
        trusted_by_observer = await self.trust_graph.find({"from_agent": observer_agent, "rating": {"$gt": 0}}).to_list(None)

        transitive_trust = []
        for peer in trusted_by_observer:
            peer_rating = await self.trust_graph.find_one({"from_agent": peer["to_agent"], "to_agent": target_agent})
            if peer_rating:
                transitive_trust.append(peer_rating["rating"] * peer["rating"])

        if not transitive_trust: return base_trust
        return (base_trust + sum(transitive_trust) / len(transitive_trust)) / 2

    async def compute_score(self, agent_id: str) -> AvairaScore:
        agent = await self.db.agents.find_one({"id": agent_id})
        if not agent:
            raise ValueError("Agent not found")

        # 1. success_rate (30%)
        total_execs = await self.db.executions.count_documents({"agent_id": agent_id})
        successful_execs = await self.db.executions.count_documents({"agent_id": agent_id, "status": "completed"})
        success_rate = (successful_execs / total_execs * 100) if total_execs > 0 else 100.0

        # 2. consistency (20%)
        # In a real app, this would compare intent vs outcome across history
        consistency = 95.0 # Placeholder

        # 3. slash_history (20%)
        slashes = await self.db.slash_events.count_documents({"agent_id": agent_id})
        slash_score = max(0, 100 - (slashes * 10))

        # 4. volume_handled (15%)
        # Log scale of total value
        pipeline = [
            {"$match": {"agent_id": agent_id, "status": "completed"}},
            {"$group": {"_id": None, "total_value": {"$sum": "$value"}}}
        ]
        cursor = self.db.executions.aggregate(pipeline)
        # Motor returns a cursor that we convert to a list
        agg_result = await cursor.to_list(length=1)
        total_value = agg_result[0]["total_value"] if agg_result else 0
        volume_score = min(100, math.log10(total_value + 1) * 20)

        # 5. age_on_network (10%)
        reg_at = datetime.fromisoformat(agent["registered_at"])
        days = (datetime.now(timezone.utc) - reg_at).days
        age_score = min(100, (days / 180) * 100)

        # 6. appeal_win_rate (5%)
        # Placeholder
        appeal_score = 100.0

        # Avaira Score (S_A) - Master Architectural Formula
        # S_A = 0.30(R_success) + 0.20(C_intent) - 0.20(P_slash) + 0.15(V_econ) + 0.10(T_maturity) + 0.05(R_appeal)
        composite = (
            success_rate * 0.30 +    # R_success: Success rate
            consistency * 0.20 +     # C_intent: Intent alignment
            slash_score * 0.20 +     # P_slash: Slash penalty (stored as positive score, effect is inverse)
            volume_score * 0.15 +    # V_econ: Economic volume
            age_score * 0.10 +       # T_maturity: Maturity/Age
            appeal_score * 0.05      # R_appeal: Appeal resolution
        )

        grade = "D"
        if composite >= 90: grade = "A+"
        elif composite >= 80: grade = "A"
        elif composite >= 70: grade = "B"
        elif composite >= 60: grade = "C"

        return AvairaScore(
            score=round(composite, 2),
            grade=grade,
            breakdown=ScoreBreakdown(
                success_rate=success_rate,
                consistency=consistency,
                slash_history=slash_score,
                volume_handled=volume_score,
                age_on_network=age_score,
                appeal_win_rate=appeal_score
            )
        )

    async def get_public_profile(self, agent_id: str) -> Dict[str, Any]:
        agent = await self.db.agents.find_one({"id": agent_id}, {"_id": 0, "api_key": 0})
        score = await self.compute_score(agent_id)
        recent_activity = await self.db.executions.find({"agent_id": agent_id}).sort("timestamp", -1).limit(10).to_list(None)
        for act in recent_activity: act.pop("_id", None)

        return {
            "agent": agent,
            "score": score.model_dump(),
            "recent_activity": recent_activity
        }

    async def anchor_state(self) -> Dict[str, Any]:
        # Software-defined state anchoring (Chainless)
        # In a real app, this could post to a centralized audit log or a distributed storage like IPFS
        # Not implemented: nothing is written anywhere. Never report a hash as anchored.
        return {
            "status": "not_implemented",
            "anchored": False,
            "audit_hash": None,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
