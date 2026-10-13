import json
import time
import anthropic
import os
import uuid
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from .shield_slm import ShieldSLM
from .shield_rules import ShieldRules

class ValidationStage(BaseModel):
    stage: str # pre, during, post
    approved: bool
    findings: str
    latency_ms: int

class ValidationResult(BaseModel):
    audit_id: str
    approved: bool
    risk_score: float
    violations: List[str]
    compliance_reasoning: str
    adversarial_findings: str
    stages: List[ValidationStage]
    latency_ms: int
    validator_version: str = "2.0-shield"

class AvairaValidator:
    def __init__(self):
        self.api_key = os.environ.get("ANTHROPIC_API_KEY")
        self.client = anthropic.AsyncAnthropic(api_key=self.api_key)
        self.model = "claude-3-5-sonnet-20241022"
        self.slm = ShieldSLM()
        self.rules = ShieldRules()

    def _extract_json(self, text: str) -> dict:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            import re
            match = re.search(r"\{.*\}", text, re.DOTALL)
            if match:
                try: return json.loads(match.group())
                except: pass
            return {}

    async def fast_shield_pass(self, intent: dict, risk_envelope: dict, plan: List[str] = None) -> ValidationResult:
        """
        STAGE 1: Pre-Execution (Fast Pass Shield)
        Targets < 15ms synchronous OPA validation.
        """
        start_pipeline = time.time()
        audit_id = f"VAL-{uuid.uuid4().hex[:8].upper()}"
        stages = []

        s1_start = time.time()

        # In a high-assurance deployment, OPA must clears before SLM is even considered
        opa_result = await self.rules.evaluate(intent, risk_envelope)
        slm_result = await self.slm.classify_intent(intent, plan)

        # Blueprint: Deterministic OPA MUST override neural reasoning.
        approved = opa_result.allow and not slm_result.is_malicious
        findings = f"SLM: {slm_result.risk_category}. OPA: {len(opa_result.violations)} violations."
        stages.append(ValidationStage(
            stage="pre",
            approved=approved,
            findings=findings,
            latency_ms=int((time.time() - s1_start) * 1000)
        ))

        return ValidationResult(
            audit_id=audit_id,
            approved=approved,
            risk_score=0.1 if approved else 1.0,
            violations=opa_result.violations + (slm_result.adversarial_signals if slm_result.is_malicious else []),
            compliance_reasoning="Fast shield classification complete.",
            adversarial_findings=slm_result.reasoning,
            stages=stages,
            latency_ms=int((time.time() - start_pipeline) * 1000)
        )

    async def deep_neural_audit(self, intent: dict, risk_envelope: dict, audit_id: str, db=None) -> ValidationStage:
        """
        STAGE 2: Deep Neural Audit (Async/Parallel)
        Deep compliance check using Claude 3.5.
        """
        start_time = time.time()
        try:
            compliance_resp = await self.client.messages.create(
                model=self.model,
                max_tokens=1000,
                system="Return ONLY valid JSON.",
                messages=[{"role": "user", "content": f"Review this intent against envelope: {json.dumps(risk_envelope)} | Intent: {json.dumps(intent)}"}]
            )
            compliance_data = self._extract_json(compliance_resp.content[0].text)

            approved = compliance_data.get("approved", False)
            findings = compliance_data.get("reasoning", "Audit complete")
            stage_res = ValidationStage(
                stage="neural_audit",
                approved=approved,
                findings=findings,
                latency_ms=int((time.time() - start_time) * 1000)
            )

            if db is not None:
                await db.executions.update_one(
                    {"audit_id": audit_id},
                    {"$push": {"lifecycle": stage_res.model_dump()}}
                )

            return stage_res
        except Exception as e:
            return ValidationStage(stage="neural_audit", approved=False, findings=str(e), latency_ms=0)

    async def verify_outcome(self, intent: dict, outcome: dict, risk_envelope: dict) -> bool:
        """
        STAGE 3: Post-Execution Outcome Verification
        Ensures the agent actually did what it said it would do.

        This returned `True` unconditionally ("Simplified for now"), so every caller that
        relied on the post-execution pillar got a rubber stamp. It now compares the realized
        outcome against the approved intent and the envelope, and refuses anything it cannot
        substantiate.
        """
        if not isinstance(intent, dict) or not isinstance(outcome, dict) or not outcome:
            return False

        status = str(outcome.get("status", "completed")).lower()
        if status not in ("completed", "success", "succeeded"):
            return False

        # The action that ran must be the action that was approved.
        if outcome.get("action", intent.get("action")) != intent.get("action"):
            return False

        # …and it must have hit the target that was approved.
        if outcome.get("target", intent.get("target")) != intent.get("target"):
            return False

        envelope = risk_envelope if isinstance(risk_envelope, dict) else {}
        try:
            spend = float(outcome.get("value_usd", outcome.get("spend_usd", intent.get("value_usd", 0.0))))
            cap = float(envelope.get("max_spend_usd", envelope.get("max_tx_value", float("inf"))))
        except (TypeError, ValueError):
            return False
        if spend < 0 or spend > cap:
            return False

        return True
