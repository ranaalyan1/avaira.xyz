"""Avaira Cognitive OS v5.0 — loop orchestration.

`AgentOS` runs the Directed Cyclic Graph:

    PLAN ──▶ PROVE ──▶ SIMULATE ──▶ EXECUTE
      ▲        │          │           │
      └────────┴──────────┘           ▼
          critique back-edges      COMPLETED

Any UNSAFE proof or low-confidence simulation routes back to PLAN with a
`Critique` event. Ambiguous goals suspend the graph at AWAIT_INPUT until
`submit_answer()` resumes it. Every state transition is appended to the
tamper-evident Cognitive Ledger; the Execution Gate is the only path to
side effects, and a gate refusal of a proven-safe plan is treated as
tampering — the stake burns atomically.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from .events import CognitiveLedger, EventBus, EventType
from .secrets import resolve_root_secret
from .execution_gate import (AttestationService, ExecutionGate,
                             LocalLedgerSlashing, RefusalReason, SlashReceipt)
from .kernel import ChunkKind, GlobalWorkingMemory, InterruptSignal, ProductionRule, RuleEngine
from .memory_tiers import SelfEditingMemory, WriteDecision
from .reasoning import AmbiguityError, PlanningRefused, System2Planner
from .schemas import (ArtifactType, Critique, EffectKind, Envelope,
                      ExecutionAudit, OSState, ParamBound, Plan, ProofResult,
                      SafetyCertificate, SandboxResult, Verdict,
                      VerificationArtifact, sha256_canonical)
from .world_model import ShadowSandbox, SymbolicProver

MAX_PLAN_ITERATIONS = 5
GATE_REFUSAL_SLASH_FRACTION = 0.25


class OSResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: OSState
    goal: str
    iterations: int = 0
    plan_hash: str = ""
    verdict: str = ""
    confidence: float = 1.0
    gate_refusals: List[str] = Field(default_factory=list)
    audit: Optional[ExecutionAudit] = None
    slash_receipt: Optional[SlashReceipt] = None
    pending_question: str = ""
    pending_question_id: str = ""
    interrupt: str = ""
    ledger_valid: bool = True
    transcript: List[str] = Field(default_factory=list)


class AgentOS:
    """The Cognitive Operating System: kernel + world model + gate + ledger."""

    def __init__(self, envelope: Envelope, agent_id: str = "avaira-agent-01",
                 initial_state: Optional[Dict[str, float]] = None,
                 stake: Optional[LocalLedgerSlashing] = None,
                 secret: str | None = None,
                 sandbox_runs: int = 200) -> None:
        self.envelope = envelope
        self.agent_id = agent_id
        # One root secret per OS instance: an env-provided secret, a per-installation
        # secret file, never the repository literal this used to default to.
        self.secret, self.secret_source = (secret, "explicit") if secret else resolve_root_secret()
        cash = envelope.bound_of("cash_usd")
        self.initial_state: Dict[str, float] = initial_state or {
            "cash_usd": cash.hi if cash else envelope.cost_cap_usd,
            "spend_total_usd": 0.0,
        }

        # Pillar A — cognitive kernel + System-2 reasoner
        self.gwm = GlobalWorkingMemory()
        self.rules = RuleEngine()
        self.planner = System2Planner()
        # Pillar B — three-tier memory
        self.memory = SelfEditingMemory(self.gwm)
        # Pillar C — world model
        self.prover = SymbolicProver()
        self.sandbox = ShadowSandbox(runs=sandbox_runs)
        # Pillar D — hardened execution
        self.gate = ExecutionGate(self.secret)
        self.attestations = AttestationService(self.secret)
        self.stake = stake or LocalLedgerSlashing()
        # Pillar E — orchestration
        self.ledger = CognitiveLedger()
        self.bus = EventBus()

        self.state = OSState.IDLE
        self.tick = 0
        self.plan: Optional[Plan] = None
        self.certificate: Optional[SafetyCertificate] = None
        self.proof: Optional[ProofResult] = None
        self.simulation: Optional[SandboxResult] = None
        self.audit: Optional[ExecutionAudit] = None
        self.slash_receipt: Optional[SlashReceipt] = None
        self.pending_question: Optional[AmbiguityError] = None
        self.interrupt: Optional[InterruptSignal] = None
        self._last_refusals: List[RefusalReason] = []

    # ------------------------------------------------------------------ api

    def register_rule(self, rule: ProductionRule) -> None:
        self.rules.register(rule)

    def run(self, goal: str, context: Optional[Dict[str, ParamBound]] = None) -> OSResult:
        self.gwm.set_goal(goal)
        self.state = OSState.PLANNING
        self._emit(EventType.GOAL_SET, {"goal": goal})
        return self._loop(goal, context or {}, tamper=False)

    def submit_answer(self, param: str, lo: float, hi: float) -> OSResult:
        """Resume an AWAIT_INPUT suspension with a concrete parameter bound."""
        if self.state != OSState.AWAIT_INPUT or self.pending_question is None:
            raise RuntimeError("no pending question: OS is not suspended at AWAIT_INPUT")
        if param != self.pending_question.missing_param:
            raise ValueError(f"expected answer for '{self.pending_question.missing_param}', got '{param}'")
        self.gwm.insert(ChunkKind.ANSWER, f"{param}:{lo}..{hi}", chunk_id=f"answer-{param}")
        self._emit(EventType.INPUT_RESUMED, {"param": param, "bound": [lo, hi]})
        self.pending_question = None
        return self._loop(self.gwm.goal.content if self.gwm.goal else "", {}, tamper=False)

    def run_forced_violation(self, goal: str,
                             context: Optional[Dict[str, ParamBound]] = None) -> OSResult:
        """Demo primitive: executes the loop but tampers with the certificate so
        the gate must refuse and the stake must burn. Never use in production."""
        self.gwm.set_goal(goal)
        self.state = OSState.PLANNING
        self._emit(EventType.GOAL_SET, {"goal": goal, "forced_violation": True})
        return self._loop(goal, context or {}, tamper=True)

    # ------------------------------------------------------------ internals

    def _emit(self, type: EventType, payload: Dict[str, object]) -> None:
        self.tick += 1
        self.ledger.append(type, self.tick, payload)

    def _result(self, status: OSState) -> OSResult:
        question = self.pending_question
        return OSResult(
            status=status,
            goal=self.gwm.goal.content if self.gwm.goal else "",
            iterations=self.plan.iteration if self.plan else 0,
            plan_hash=self.plan.plan_hash() if self.plan else "",
            verdict=self.proof.verdict.value if self.proof else "",
            confidence=self.simulation.confidence if self.simulation else 1.0,
            gate_refusals=[r.value for r in self._last_refusals],
            audit=self.audit,
            slash_receipt=self.slash_receipt,
            pending_question=question.question if question else "",
            pending_question_id=question.question_id if question else "",
            interrupt=str(self.interrupt) if self.interrupt else "",
            ledger_valid=self.ledger.verify_chain(),
            transcript=self.ledger.transcript(),
        )

    def _check_reflexes(self) -> bool:
        """Priority >= 9 rules abort the loop (fail-safe, not fail-open)."""
        try:
            self.rules.evaluate(self.gwm)
            self.rules.check_interrupts(self.gwm)
            return True
        except InterruptSignal as signal:
            self.interrupt = signal
            self.state = OSState.ABORTED
            self._emit(EventType.INTERRUPT, {
                "rule": signal.rule_name, "priority": signal.priority, "reason": signal.reason,
            })
            return False

    def _loop(self, goal: str, context: Dict[str, ParamBound], tamper: bool) -> OSResult:
        critique: Optional[Critique] = None
        self._last_refusals: List[RefusalReason] = []

        for _ in range(MAX_PLAN_ITERATIONS):
            if not self._check_reflexes():
                return self._result(OSState.ABORTED)

            # ------------------------------------------------ PLAN
            self.state = OSState.PLANNING
            try:
                plan = self.planner.plan(goal, self.gwm, self.envelope,
                                         critique=critique, context=context,
                                         initial_state=self.initial_state)
            except AmbiguityError as ambiguity:
                self.pending_question = ambiguity
                self.state = OSState.AWAIT_INPUT
                self._emit(EventType.AMBIGUITY_SUSPENDED, {
                    "question_id": ambiguity.question_id,
                    "question": ambiguity.question,
                })
                return self._result(OSState.AWAIT_INPUT)
            except PlanningRefused as refused:
                self.state = OSState.REFUSED
                self._emit(EventType.REFUSED, {"reason": str(refused), "fail_closed": True})
                return self._result(OSState.REFUSED)
            self.plan = plan
            self._emit(EventType.PLAN_EMITTED, {
                "plan_hash": plan.plan_hash(), "iteration": plan.iteration,
                "steps": len(plan.steps), "worst_case_cost": plan.total_cost_hi(),
            })

            # ------------------------------------------------ PROVE
            self.state = OSState.PROVING
            self.proof = self.prover.prove(plan, self.envelope, self.initial_state)
            self._emit(EventType.PROOF_COMPLETED, {
                "verdict": self.proof.verdict.value, "reason": self.proof.reason,
            })
            if self.proof.verdict == Verdict.UNSAFE:
                critique = Critique(
                    origin="prover",
                    reason=self.proof.reason,
                    iteration=plan.iteration,
                    witness=self.proof.witness,
                )
                self._emit(EventType.CRITIQUE, {
                    "origin": "prover", "back_edge": "PLAN", "reason": self.proof.reason,
                })
                self.gwm.insert(ChunkKind.CRITIQUE, f"UNSAFE: {self.proof.reason}")
                continue
            if self.proof.verdict == Verdict.UNKNOWN:
                # fail-closed: an unprovable plan is a refused plan
                self.state = OSState.REFUSED
                self._emit(EventType.REFUSED, {
                    "reason": self.proof.reason, "fail_closed": True,
                })
                return self._result(OSState.REFUSED)

            # ------------------------------------------------ SIMULATE
            self.state = OSState.SIMULATING
            self.simulation = self.sandbox.simulate(plan, self.envelope, self.initial_state)
            self._emit(EventType.SIMULATION_COMPLETED, {
                "runs": self.simulation.runs,
                "violations": self.simulation.violations,
                "confidence": self.simulation.confidence,
            })
            if self.simulation.confidence < 1.0:
                critique = Critique(
                    origin="sandbox",
                    reason=(f"shadow sandbox confidence {self.simulation.confidence:.3f} "
                            f"({self.simulation.violations}/{self.simulation.runs} runs violated bounds)"),
                    iteration=plan.iteration,
                )
                self._emit(EventType.CRITIQUE, {
                    "origin": "sandbox", "back_edge": "PLAN",
                    "confidence": self.simulation.confidence,
                })
                self.gwm.insert(ChunkKind.CRITIQUE, critique.reason)
                continue

            # ------------------------------------------------ EXECUTE
            self.state = OSState.EXECUTING
            certificate = self._mint_certificate(plan)
            if tamper:
                # sign with a foreign key: the gate must catch this
                certificate = certificate.sign("attacker-key-not-the-os-key")
            self.certificate = certificate
            attestation = self.attestations.issue(self.agent_id, nonce=plan.plan_hash()[:16])
            decision = self.gate.authorize(plan, certificate, attestation, self.envelope)
            if not decision.allowed:
                self._last_refusals = decision.refusals
                self.state = OSState.REFUSED
                self._emit(EventType.GATE_REFUSED, {
                    "refusals": [r.value for r in decision.refusals],
                    "tamper_detected": tamper,
                })
                self._slash_for_refusal(plan)
                return self._result(OSState.SLASHED if self.slash_receipt else OSState.REFUSED)

            self.audit = self._execute(plan)
            self._emit(EventType.EXECUTED, {
                "audit_id": self.audit.audit_id,
                "final_state": self.audit.final_state,
            })
            self._record_belief(plan)
            self.state = OSState.COMPLETED
            self._emit(EventType.COMPLETED, {"plan_hash": plan.plan_hash()})
            return self._result(OSState.COMPLETED)

        # iteration budget exhausted — fail closed
        self.state = OSState.REFUSED
        self._emit(EventType.REFUSED, {
            "reason": f"plan did not converge within {MAX_PLAN_ITERATIONS} iterations",
            "fail_closed": True,
        })
        return self._result(OSState.REFUSED)

    # -- helpers -----------------------------------------------------------

    def _mint_certificate(self, plan: Plan) -> SafetyCertificate:
        nonce = sha256_canonical({"plan": plan.plan_hash(), "tick": self.tick})[:16]
        certificate = SafetyCertificate(
            plan_hash=plan.plan_hash(),
            verdict=Verdict.SAFE,
            nonce=nonce,
            issued_tick=self.tick,
        )
        return certificate.sign(self.secret)

    def _execute(self, plan: Plan) -> ExecutionAudit:
        """Deterministic sandboxed executor: applies each step's midpoint cost."""
        state = dict(self.initial_state)
        for step in plan.steps:
            for effect in step.effects:
                param = step.amount_of(effect)
                amount = (param.lo + param.hi) / 2.0
                variable = effect.variable
                state.setdefault(variable, 0.0)
                if effect.kind == EffectKind.SPEND:
                    state[variable] -= amount
                    if self.envelope.bound_of("spend_total_usd") is not None:
                        state["spend_total_usd"] = state.get("spend_total_usd", 0.0) + amount
                elif effect.kind == EffectKind.CREDIT:
                    state[variable] += amount
                elif effect.kind == EffectKind.SET:
                    state[variable] = amount
        return ExecutionAudit(
            audit_id=f"AUD-{plan.plan_hash()[:12].upper()}",
            plan_hash=plan.plan_hash(),
            status="completed",
            final_state={k: round(v, 6) for k, v in state.items()},
            steps_executed=len(plan.steps),
        )

    def _record_belief(self, plan: Plan) -> None:
        """Proof-gated memory write backed by the ExecutionAudit artifact."""
        if self.audit is None:
            return
        artifact = self.memory_artifact()
        write = self.memory.write_belief(
            subject="agent", predicate="executed_plan", obj=plan.plan_hash(),
            confidence=0.95, artifact=artifact,
        )
        if write.decision == WriteDecision.ACCEPTED:
            self._emit(EventType.MEMORY_WRITTEN, {"belief": f"agent/executed_plan/{plan.plan_hash()[:16]}"})
        else:
            self._emit(EventType.MEMORY_REJECTED, {"reason": write.reason})

    def memory_artifact(self) -> "VerificationArtifact":
        assert self.audit is not None
        return VerificationArtifact(
            type=ArtifactType.EXECUTION_AUDIT,
            ref=self.audit.audit_id,
            source="cognitive-os-executor",
        )

    def _slash_for_refusal(self, plan: Plan) -> None:
        """A gate refusal of a proven-safe plan means the trust chain was
        tampered with: burn stake atomically and render on-chain settlement."""
        stake = self.stake.stake_of(self.agent_id)
        amount = round(stake * GATE_REFUSAL_SLASH_FRACTION, 2)
        if stake <= 0 or amount <= 0:
            return
        evidence = sha256_canonical({
            "plan": plan.plan_hash(),
            "refusals": [r.value for r in self._last_refusals],
        })
        try:
            self.slash_receipt = self.stake.burn(
                self.agent_id, amount, "execution_gate_refusal", evidence_hash=evidence,
            )
            self._emit(EventType.SLASHED, {
                "amount": amount, "remaining_stake": self.slash_receipt.remaining_stake,
                "evidence_hash": evidence,
            })
        except Exception as exc:  # atomic burn refused — record, never proceed
            self._emit(EventType.GATE_REFUSED, {"slash_failed": str(exc)})
