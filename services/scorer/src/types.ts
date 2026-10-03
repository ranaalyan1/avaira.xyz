/**
 * Avaira Score — types.
 *
 * Design rule: every number that reaches the chain must be recomputable by a third party
 * from public data plus the published formula. So the breakdown is not a log line — it is
 * the product. `inputsHash` anchors the exact inputs used, `formulaVersion` anchors the
 * exact rules applied, and anyone can re-run `computeScore(inputs)` to check the result.
 */

export const FORMULA_VERSION = "avaira-score-1.0.0";

/** The six weighted components. Weights sum to 100 and are part of the onchain-visible formula. */
export const WEIGHTS = {
  successRate: 30,
  consistency: 20,
  slashHistory: 20,
  volumeHandled: 15,
  ageOnNetwork: 10,
  appealWinRate: 5,
} as const;

export type ComponentKey = keyof typeof WEIGHTS;

/** Raw, public inputs. This is the object that gets hashed and anchored. */
export interface ScoreInputs {
  agentId: string;
  chainId: number;
  /** Unix seconds of the ERC-8004 registration, or null when the agent is unknown. */
  registeredAt: number | null;
  /** Lifecycle status from the stake registry (0 NONE … 4 BANNED). */
  status: number;
  stakeUsdc: string;
  minStakeUsdc: string;
  minScore: number;

  /** Proof-of-Intent history. */
  intentsCommitted: number;
  outcomesAttested: number;
  deviationsUpheld: number;
  challengesRejected: number;
  /** Attested/existing intents with their outcome time, for the consistency windows. */
  attestedIntents: { intentHash: string; at: number; deviated: boolean }[];

  /** Slashing history, newest first is not required. */
  slashEvents: { level: number; at: number; reason: string; amountUsdc: string }[];

  /** Gate telemetry written by the SDK/agent (`GateDecisionRecorded`). */
  gateAllows: number;
  gateBlocks: number;
  gateLatencyMsAvg: number;

  /** Grounded ERC-8004 feedback. */
  feedbackCount: number;
  feedbackUniqueReviewers: number;
  /** Feedback values normalised to 0–100 by the reader. */
  feedbackValues: number[];
  /** Settled USD-denominated volume, 6-decimal USDC units. */
  volumeUsd: string;

  /** ERC-8004 validation registry responses for this agent. */
  validationCount: number;
  validationAverageResponse: number;

  /** Appeals resolved through validation responses tagged `appeal`. */
  appealCases: number;
  appealWins: number;

  /** Chain window the data was read from (inclusive block range). */
  fromBlock: string;
  toBlock: string;
}

export interface ComponentScore {
  key: ComponentKey;
  /** Points awarded, after the component's own internal rules. */
  points: number;
  /** Maximum points available from `WEIGHTS[key]`. */
  max: number;
  /** The normalised value the points were derived from, in [0, 1] where applicable. */
  raw: number;
  /** One-line, human-readable justification — shown in the dashboard and read by the auditor. */
  detail: string;
}

export interface ScoreCap {
  rule: string;
  cap: number;
  reason: string;
}

/** The result of the adversarial pass. Only *negative*, bounded, reasoned adjustments apply. */
export interface AdversarialAudit {
  model: string;
  passes: number;
  /** Concerns raised in pass 1 (argue against the agent). */
  findings: { component: ComponentKey; severity: "low" | "medium" | "high"; claim: string; evidence: string }[];
  /** Adjudications from pass 2. */
  rulings: { index: number; verdict: "grounded" | "ungrounded"; justification: string }[];
  /** Total points removed (<= MAX_AUDIT_PENALTY, and never applied to slash/volume). */
  penalty: number;
  rationale: string;
  /** Set when the auditor could not be reached. The score is then base-only, never faked. */
  unavailableReason?: string;
}

export interface ScoreBreakdown {
  agentId: string;
  formulaVersion: string;
  computedAt: string;
  inputs: ScoreInputs;
  components: ComponentScore[];
  subtotal: number;
  caps: ScoreCap[];
  audit: AdversarialAudit | null;
  penalty: number;
  score: number;
  grade: string;
  /** keccak256 over the canonical JSON of `inputs`. Anchored onchain as `breakdownHash`. */
  inputsHash: `0x${string}`;
  /** keccak256 over the canonical JSON of the whole breakdown (minus this field). */
  breakdownHash: `0x${string}`;
  /** Evidence URI published alongside the anchor (IPFS/HTTP/GitHub). */
  evidenceURI: string;
  /** Transaction that posted the score, once anchored. */
  anchorTxHash?: `0x${string}`;
  anchoredBlock?: string;
}
