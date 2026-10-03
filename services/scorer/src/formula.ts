/**
 * The Avaira Score, in pure functions.
 *
 * Six weighted components, all derived from data a stranger can re-read from Monad:
 *
 *   SuccessRate   30  share of committed intents that ended in an attested, undeviated outcome
 *   Consistency   20  stability of that success rate across time windows
 *   SlashHistory  20  severity-weighted, decaying penalty for slashing events
 *   VolumeHandled 15  log-scaled grounded settlement volume
 *   AgeOnNetwork  10  time since ERC-8004 registration, saturating at 30 days
 *   AppealWinRate  5  share of appeals (validation responses tagged `appeal`) won
 *
 * Two rules keep this honest:
 *
 *   1. Small samples are smoothed, never guessed. Rates use a Laplace prior so an agent with
 *      one successful run cannot outrank one with a thousand, and a brand-new agent starts
 *      just below a B (22.5/30) instead of at zero or at the top.
 *   2. Caps, not weights, enforce eligibility. Stake buys entry into the system, never points:
 *      the only place collateral appears is a cap that marks the agent ineligible, which
 *      cannot be bought back by posting more of it.
 *
 * Everything here is deterministic: same inputs in, same score out, on any machine.
 */
import { WEIGHTS, type ComponentKey, type ComponentScore, type ScoreCap, type ScoreInputs } from "./types.js";

/** USDC has 6 decimals; inputs carry 6-decimal units as strings. */
const USDC = 1_000_000n;

/** Volume that earns full marks on VolumeHandled. */
const VOLUME_FULL_USDC = 1_000_000;
/** Age that earns full marks on AgeOnNetwork. */
const AGE_FULL_DAYS = 30;
/** Half-life of a slash penalty, in days. Misconduct fades — slowly. */
const SLASH_HALF_LIFE_DAYS = 45;

const SLASH_PENALTY: Record<number, number> = {
  0: 0, // NONE
  1: 3, // WARNING
  2: 10, // SUSPENSION
  3: 20, // BAN
};

const GRADE_BANDS: { min: number; grade: string }[] = [
  { min: 95, grade: "A+" },
  { min: 90, grade: "A" },
  { min: 85, grade: "A-" },
  { min: 80, grade: "B+" },
  { min: 75, grade: "B" },
  { min: 70, grade: "B-" },
  { min: 65, grade: "C+" },
  { min: 60, grade: "C" },
  { min: 55, grade: "C-" },
  { min: 0, grade: "D" },
];

export const MAX_AUDIT_PENALTY = 15;

export function gradeForScore(score: number): string {
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.grade;
  }
  return "D";
}

/** Laplace-smoothed ratio: `(successes + α·prior) / (attempts + α)`. */
export function smoothedRate(successes: number, attempts: number, prior: number, alpha: number): number {
  const a = Math.max(0, attempts);
  const s = Math.min(Math.max(0, successes), a);
  return (s + alpha * prior) / (a + alpha);
}

/** `Σ penalty · 0.5^(ageDays / halfLife)`, i.e. misconduct decays but never disappears. */
export function decayedSlashPenalty(
  events: { level: number; at: number }[],
  nowSeconds: number,
  halfLifeDays = SLASH_HALF_LIFE_DAYS,
): number {
  let total = 0;
  for (const event of events) {
    const base = SLASH_PENALTY[event.level] ?? 0;
    if (base === 0) continue;
    const ageDays = Math.max(0, (nowSeconds - event.at) / 86_400);
    total += base * 0.5 ** (ageDays / halfLifeDays);
  }
  return total;
}

/**
 * Success rate per contiguous time window.
 *
 * Consistency is measured, not assumed: an agent that is flawless in one window and
 * unreliable in the next is a liability even with a good average, and this is the component
 * that says so. Windows are index-based (equal sample sizes) so a burst of activity cannot
 * hide inside one bucket.
 */
export function consistencySpread(attested: { at: number; deviated: boolean }[], windows = 4): number | null {
  if (attested.length < windows) return null;
  const sorted = [...attested].sort((a, b) => a.at - b.at);
  const size = Math.floor(sorted.length / windows);
  if (size === 0) return null;

  const rates: number[] = [];
  for (let w = 0; w < windows; w++) {
    const slice = sorted.slice(w * size, w === windows - 1 ? sorted.length : (w + 1) * size);
    if (slice.length === 0) continue;
    const failures = slice.filter((s) => s.deviated).length;
    rates.push((slice.length - failures) / slice.length);
  }
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

export function computeComponents(inputs: ScoreInputs, nowSeconds: number): ComponentScore[] {
  const components: ComponentScore[] = [];

  /* ── SuccessRate ─────────────────────────────────────────────────────────── */
  const deviations = inputs.deviationsUpheld;
  const successes = Math.max(0, inputs.outcomesAttested - deviations);
  // A commitment with no attested outcome is a failure: the agent said it would act and
  // did not deliver onchain evidence of acting.
  const unfulfilled = Math.max(0, inputs.intentsCommitted - inputs.outcomesAttested);
  const failures = deviations + unfulfilled;
  const attempts = successes + failures;

  const successRate = smoothedRate(successes, attempts, 0.75, 8);
  components.push({
    key: "successRate",
    points: WEIGHTS.successRate * successRate,
    max: WEIGHTS.successRate,
    raw: successRate,
    detail:
      attempts === 0
        ? "no committed intents yet — Laplace prior (0.75) applied"
        : `${successes} clean outcomes, ${deviations} upheld deviations, ${unfulfilled} unfulfilled commitments ` +
          `(smoothed rate ${(successRate * 100).toFixed(1)}%)`,
  });

  /* ── Consistency ─────────────────────────────────────────────────────────── */
  const spread = consistencySpread(inputs.attestedIntents);
  const consistency = spread === null ? 0.75 : Math.max(0, 1 - spread);
  components.push({
    key: "consistency",
    points: WEIGHTS.consistency * consistency,
    max: WEIGHTS.consistency,
    raw: consistency,
    detail:
      spread === null
        ? `fewer than 4 attested outcomes — prior (0.75) applied`
        : `success rate spread of ${(spread * 100).toFixed(1)} points across 4 windows`,
  });

  /* ── SlashHistory ────────────────────────────────────────────────────────── */
  const penalty = decayedSlashPenalty(inputs.slashEvents, nowSeconds);
  const slashPoints = Math.max(0, WEIGHTS.slashHistory - penalty);
  const worstLevel = inputs.slashEvents.reduce((max, e) => Math.max(max, e.level), 0);
  components.push({
    key: "slashHistory",
    points: slashPoints,
    max: WEIGHTS.slashHistory,
    raw: slashPoints / WEIGHTS.slashHistory,
    detail:
      inputs.slashEvents.length === 0
        ? "no slashing events"
        : `${inputs.slashEvents.length} event(s), worst level ${worstLevel}, decayed penalty ${penalty.toFixed(2)}`,
  });

  /* ── VolumeHandled ───────────────────────────────────────────────────────── */
  const volumeUsdc = Number(inputs.volumeUsd) / Number(USDC);
  const volumeRatio = volumeUsdc <= 0 ? 0 : Math.min(1, Math.log10(1 + volumeUsdc / 1000) / 3);
  components.push({
    key: "volumeHandled",
    points: WEIGHTS.volumeHandled * volumeRatio,
    max: WEIGHTS.volumeHandled,
    raw: volumeRatio,
    detail: `$${volumeUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} grounded volume ` +
      `(full marks at $${VOLUME_FULL_USDC.toLocaleString("en-US")})`,
  });

  /* ── AgeOnNetwork ────────────────────────────────────────────────────────── */
  const ageDays = inputs.registeredAt === null ? 0 : Math.max(0, (nowSeconds - inputs.registeredAt) / 86_400);
  const ageRatio = Math.min(1, ageDays / AGE_FULL_DAYS);
  components.push({
    key: "ageOnNetwork",
    points: WEIGHTS.ageOnNetwork * ageRatio,
    max: WEIGHTS.ageOnNetwork,
    raw: ageRatio,
    detail: inputs.registeredAt === null ? "not registered" : `${ageDays.toFixed(1)} days on Monad`,
  });

  /* ── AppealWinRate ───────────────────────────────────────────────────────── */
  const appealRate = smoothedRate(inputs.appealWins, inputs.appealCases, 0.5, 4);
  components.push({
    key: "appealWinRate",
    points: WEIGHTS.appealWinRate * appealRate,
    max: WEIGHTS.appealWinRate,
    raw: appealRate,
    detail:
      inputs.appealCases === 0
        ? "no appeals — prior (0.5) applied"
        : `${inputs.appealWins}/${inputs.appealCases} appeals upheld`,
  });

  return components;
}

/**
 * Eligibility caps.
 *
 * These are the circuit breaker. A cap can only *lower* a score, and every one of them maps
 * to a condition a stranger can verify onchain. None of them can be lifted by spending.
 */
export function computeCaps(inputs: ScoreInputs, nowSeconds: number, blockCap = 59): ScoreCap[] {
  const caps: ScoreCap[] = [];

  if (inputs.status === 4) {
    caps.push({ rule: "banned", cap: 0, reason: "agent is permanently banned" });
  } else if (inputs.status === 3) {
    caps.push({ rule: "suspended", cap: 55, reason: "agent is suspended after a slashing event" });
  }

  if (BigInt(inputs.stakeUsdc) < BigInt(inputs.minStakeUsdc)) {
    caps.push({
      rule: "stake-below-minimum",
      cap: blockCap,
      reason: `stake ${inputs.stakeUsdc} is below the protocol minimum ${inputs.minStakeUsdc} (6-decimals USDC)`,
    });
  }

  const oneDayAgo = nowSeconds - 86_400;
  const recentDeviation = inputs.attestedIntents.some((intent) => intent.deviated && intent.at >= oneDayAgo);
  if (recentDeviation) {
    caps.push({
      rule: "recent-deviation",
      cap: blockCap,
      reason: "an upheld deviation was recorded within the last 24h — the gate refuses this agent",
    });
  }

  const attempts = inputs.intentsCommitted;
  if (attempts >= 4) {
    const unfulfilled = Math.max(0, attempts - inputs.outcomesAttested);
    if (unfulfilled / attempts > 0.5) {
      caps.push({
        rule: "mostly-unfulfilled",
        cap: blockCap,
        reason: `${unfulfilled} of ${attempts} commitments have no attested outcome`,
      });
    }
  }

  return caps;
}

export interface ScoreResult {
  components: ComponentScore[];
  subtotal: number;
  caps: ScoreCap[];
  /** Points removed by the adversarial audit (already bounded by the caller). */
  penalty: number;
  score: number;
  grade: string;
}

/** Deterministic score. `penalty` is passed in by the caller so this stays pure. */
export function computeScore(inputs: ScoreInputs, nowSeconds: number, penalty = 0): ScoreResult {
  const components = computeComponents(inputs, nowSeconds);
  const subtotal = components.reduce((sum, c) => sum + c.points, 0);

  const boundedPenalty = Math.min(Math.max(0, penalty), MAX_AUDIT_PENALTY);
  let score = subtotal - boundedPenalty;

  const caps = computeCaps(inputs, nowSeconds);
  for (const cap of caps) score = Math.min(score, cap.cap);

  score = Math.max(0, Math.min(100, score));

  return {
    components,
    subtotal,
    caps,
    penalty: boundedPenalty,
    score: Math.round(score * 100) / 100,
    grade: gradeForScore(score),
  };
}

/** Component key → weight, for dashboards and for the auditor's prompt. */
export function weights(): Record<ComponentKey, number> {
  return { ...WEIGHTS };
}
