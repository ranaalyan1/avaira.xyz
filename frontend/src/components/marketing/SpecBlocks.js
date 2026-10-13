/**
 * Spec blocks.
 *
 * Each block is built from a fact that lives in this repository, so the
 * marketing page and the code cannot drift apart silently:
 *
 *   RefusalTable   the GateReason enum, contracts/src/interfaces/IAvaira.sol
 *   ScoreWeights   the six weighted terms, backend/core/reputation.py
 *   ScoreLadder    the grade bands, backend/core/reputation.py
 *   PenaltyLadder  suspension and ban semantics, IAvaira.sol + AvairaStakeRegistry.sol
 *   EvidenceTable  measured numbers from contracts/metrics and verification/reports
 *
 * Figures count up or draw in on scroll. The static markup already carries the
 * final values, so a crawler or a reduced-motion visitor reads the real numbers.
 */
import { DARK, CHART_COLORS } from "@/lib/palette";
import { useCountUp, useEnterAnimation, animate, createTimeline, stagger } from "@/lib/motion";

/* ── refusals ─────────────────────────────────────────────────────────────
 * The nine ways the gate says no, in enum order. ALLOWED is index 0 and leads
 * the list so the contrast is visible.
 */
const REASONS = [
  ["ALLOWED", "agent cleared to execute", "clear"],
  ["UNKNOWN_AGENT", "no identity is registered for this address", "stop"],
  ["BANNED", "terminal ban, no path back", "stop"],
  ["SUSPENDED", "slashed into suspension, waiting on collateral", "stop"],
  ["STAKE_TOO_LOW", "bond sits below the minimum the envelope requires", "stop"],
  ["SCORE_TOO_LOW", "Avaira Score under the floor the mission demands", "stop"],
  ["INTENT_NOT_COMMITTED", "no commitment matches the intent hash", "stop"],
  ["INTENT_EXPIRED", "the envelope deadline has passed", "stop"],
  ["INTENT_ALREADY_EXECUTED", "the intent is single use and was already attested", "stop"],
  ["ENVELOPE_MISMATCH", "the stored envelope does not match the committed hash", "stop"],
];

export function RefusalTable() {
  return (
    <div className="spec-table" data-testid="refusal-table">
      <div className="spec-row spec-row-head">
        <span>code</span>
        <span>fires when</span>
      </div>
      {REASONS.map(([code, meaning, kind]) => (
        <div className="spec-row" data-reveal key={code}>
          <span className={`spec-code${kind === "clear" ? " is-clear" : ""}`}>{code}</span>
          <span className="spec-meaning">{meaning}</span>
        </div>
      ))}
    </div>
  );
}

/* ── score ───────────────────────────────────────────────────────────────── */

const WEIGHTS = [
  ["success rate", 0.3],
  ["intent alignment", 0.2],
  ["slash history", 0.2],
  ["economic volume", 0.15],
  ["time on network", 0.1],
  ["appeal resolution", 0.05],
];

const GRADES = [
  ["D", 0, 60],
  ["C", 60, 70],
  ["B", 70, 80],
  ["A", 80, 90],
  ["A+", 90, 100],
];

export function ScoreWeights() {
  const ref = useEnterAnimation((_scope, root) => {
    const segments = root.querySelectorAll("[data-weight-segment]");
    animate(segments, { scaleX: [0, 1], duration: 900, delay: stagger(80), ease: "out(3)" });
  });

  return (
    <div className="weights" ref={ref} data-testid="score-weights">
      <div className="weights-bar" role="img" aria-label="Score weights: success rate 0.30, intent alignment 0.20, slash history 0.20, economic volume 0.15, time on network 0.10, appeal resolution 0.05">
        {WEIGHTS.map(([label, weight], index) => (
          <span
            key={label}
            className="weight-segment"
            data-weight-segment
            style={{ flexGrow: weight, background: CHART_COLORS[index] }}
            title={`${label} ${weight.toFixed(2)}`}
          />
        ))}
      </div>

      <ul className="weights-list">
        {WEIGHTS.map(([label, weight], index) => (
          <li key={label} data-reveal>
            <span className="weight-swatch" style={{ background: CHART_COLORS[index] }} />
            <span className="weight-label">{label}</span>
            <span className="weight-value">{weight.toFixed(2)}</span>
          </li>
        ))}
      </ul>

      <p className="weights-caption">
        Six terms, fixed coefficients. The same history always produces the same score, so anyone can
        recompute it and challenge the result on chain.
      </p>
    </div>
  );
}

const SAMPLE_SCORE = 87.4;

export function ScoreLadder() {
  const [scoreRef, scoreText] = useCountUp(SAMPLE_SCORE, { decimals: 1, duration: 1600 });

  const ref = useEnterAnimation((_scope, root) => {
    createTimeline()
      .add(root.querySelector("[data-score-marker]"), {
        left: ["0%", `${SAMPLE_SCORE}%`],
        duration: 1500,
        ease: "out(4)",
      })
      .add(
        root.querySelectorAll("[data-grade-tick]"),
        { opacity: [0, 1], translateY: [6, 0], duration: 420, delay: stagger(70) },
        260
      );
  });

  return (
    <div className="ladder" ref={ref} data-testid="score-ladder">
      <div className="ladder-track">
        {GRADES.map(([grade, from]) => (
          <div
            key={grade}
            className={`ladder-band ladder-band-${grade.replace("+", "plus").toLowerCase()}`}
            data-grade-tick
            style={{ width: `${100 / GRADES.length}%` }}
          >
            <span className="ladder-grade">{grade}</span>
          </div>
        ))}
        <span className="ladder-scale ladder-scale-low">0</span>
        <span className="ladder-scale ladder-scale-high">100</span>
        <div
          className="ladder-marker"
          data-score-marker
          style={{ left: `${SAMPLE_SCORE}%` }}
          ref={scoreRef}
        >
          <span className="ladder-marker-line" />
          <span className="ladder-marker-label">orion-11 {scoreText}</span>
        </div>
      </div>

      <div className="ladder-key">
        {GRADES.map(([grade, from, to]) => (
          <span className="ladder-key-item" key={grade}>
            <span className={`ladder-key-grade ladder-key-${grade.replace("+", "plus").toLowerCase()}`}>{grade}</span>
            <span className="ladder-key-range">
              {from} to {to}
            </span>
          </span>
        ))}
      </div>

      <p className="ladder-caption">
        Credit terms follow the band: 80 and above borrows against 110% collateral, 90 and above
        against 150%. Below 60 the credit market is closed until the score recovers.
      </p>
    </div>
  );
}

/* ── penalties ──────────────────────────────────────────────────────────────
 * The ladder is a state machine, not a notification: what changes, how long it
 * lasts, and what it takes to come back.
 */
const PENALTIES = [
  {
    state: "WARNING",
    tone: "warning",
    what: "the deviation is recorded against the agent and its envelope is tightened",
    back: "no action required",
  },
  {
    state: "SUSPENDED",
    tone: "warning",
    what: "collateral is slashed, the agent is frozen and its credit line is closed",
    back: "re-collateralise after the 24 hour suspension cooldown",
  },
  {
    state: "BANNED",
    tone: "danger",
    what: "the identity is terminal, the bond is burned and the registry marks it permanently",
    back: "no path back",
  },
];

export function PenaltyLadder() {
  const ref = useEnterAnimation((_scope, root) => {
    animate(root.querySelectorAll("[data-penalty]"), {
      opacity: [0, 1],
      translateY: [18, 0],
      duration: 620,
      delay: stagger(150),
      ease: "out(3)",
    });
    animate(root.querySelector("[data-penalty-line]"), { scaleY: [0, 1], duration: 1400, ease: "linear" });
  });

  return (
    <div className="penalties" ref={ref} data-testid="penalty-ladder">
      <span className="penalty-line" data-penalty-line aria-hidden="true" />
      {PENALTIES.map(({ state, tone, what, back }) => (
        <article className="penalty" data-penalty key={state}>
          <span className={`penalty-state tone-${tone}`}>{state}</span>
          <p className="penalty-what">{what}</p>
          <p className="penalty-back">
            <span className="penalty-back-label">recovery</span>
            {back}
          </p>
        </article>
      ))}
    </div>
  );
}

/* ── evidence ───────────────────────────────────────────────────────────── */

const EVIDENCE = [
  { label: "Foundry tests", value: 123, note: "run against the contracts on every change" },
  { label: "Core line coverage", value: 94.4, decimals: 1, suffix: "%", note: "contracts/metrics/coverage.txt" },
  { label: "Attack scenarios", value: 12, note: "written up in FINDINGS.md and re-run as a tripwire" },
  { label: "Rollouts per intent", value: 200, note: "seeded Monte-Carlo shadow sandbox" },
  { label: "State exploration depth", value: 12, note: "py-evm on Cancun against the Foundry profile" },
  { label: "Parity corpus vectors", value: 13, note: "adversarial leaves, no failures in the last run" },
  { label: "Campaign calls", value: 8031, note: "state exploration run recorded in the verification reports" },
  { label: "Suspension cooldown", value: 24, suffix: "h", note: "before a suspended agent may re-collateralise" },
];

const EvidenceRow = ({ label, value, decimals = 0, suffix = "", note }) => {
  const [ref, display] = useCountUp(value, { decimals, suffix });
  return (
    <div className="evidence-row" data-reveal>
      <span className="evidence-figure" ref={ref}>
        {display}
      </span>
      <span className="evidence-label">{label}</span>
      <span className="evidence-note">{note}</span>
    </div>
  );
};

export function EvidenceTable() {
  return (
    <div className="evidence" data-testid="evidence-table">
      {EVIDENCE.map((row) => (
        <EvidenceRow key={row.label} {...row} />
      ))}
    </div>
  );
}

export { DARK };
