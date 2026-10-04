/**
 * Minimal, hand-written ABIs.
 *
 * Deliberately not generated: the SDK should depend on the *contract surface*, not on
 * build artefacts, so a version bump in the dashboard never breaks an agent runtime.
 */
import { parseAbi, defineChain } from "viem";

/** Monad testnet (chain id 10143). */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
  testnet: true,
});

/** Monad mainnet (chain id 143). */
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monadscan", url: "https://monadscan.com" } },
});

export const INTENT_VAULT_ABI = parseAbi([
  "function commitIntent(uint256 agentId, bytes32 intentHash, (uint256 maxSpendUsd, string[] allowedActions, uint64 deadline) envelope)",
  "function attestOutcome(uint256 agentId, bytes32 intentHash, bytes32 outcomeHash, bytes32 merkleRoot)",
  "function checkGate(uint256 agentId) view returns (bool allowed, uint8 score, uint8 reason)",
  "function checkGate(uint256 agentId, bytes32 intentHash) view returns (bool allowed, uint8 score, uint8 reason)",
  "function checkGate(uint256 agentId, bytes32 intentHash, bytes32 envelopeHash) view returns (bool allowed, uint8 score, uint8 reason)",
  "function recordGateDecision(uint256 agentId, bytes32 intentHash, bool allowed, uint8 reason, uint32 latencyMs)",
  "function challengeDeviation(uint256 agentId, bytes32 intentHash, (uint256 agentId, bytes32 intentHash, string action, uint256 spendUsd, uint256 nonce) leaf, bytes32[] merkleProof)",
  "function isChallengeOpen(uint256 agentId, bytes32 intentHash) view returns (bool)",
  "function getIntent(uint256 agentId, bytes32 intentHash) view returns ((uint256 agentId, bytes32 envelopeHash, uint256 maxSpendUsd, uint64 deadline, uint64 committedAt, uint64 challengeEndsAt, bytes32 outcomeHash, bytes32 outcomeRoot, bool executed, bool challenged, bool deviationUpheld, address committer))",
  "function allowedActionsOf(uint256 agentId, bytes32 intentHash) view returns (string[])",
  "function challengerBond() view returns (uint256)",
  "function challengeWindow() view returns (uint64)",
  "event IntentCommitted(uint256 indexed agentId, bytes32 indexed intentHash, bytes32 envelopeHash, uint64 deadline, uint256 maxSpendUsd)",
  "event OutcomeAttested(uint256 indexed agentId, bytes32 indexed intentHash, bytes32 outcomeHash, bytes32 merkleRoot, uint64 challengeEndsAt)",
  "event DeviationUpheld(uint256 indexed agentId, bytes32 indexed intentHash, address indexed challenger, uint256 bounty, uint256 slashed)",
  "event GateDecisionRecorded(uint256 indexed agentId, bytes32 indexed intentHash, bool allowed, uint8 reason, uint32 latencyMs)",
  "event ChallengeRejected(uint256 indexed agentId, bytes32 indexed intentHash, address indexed challenger, uint256 bondForfeited)",
]);

/**
 * Gate reads use standalone ABIs with a single `checkGate` signature each.
 *
 * `checkGate` is deliberately overloaded onchain (agent-level, intent-level,
 * intent+envelope-level) — which is what lets an agent call it before and after
 * committing. viem needs exactly one matching fragment to infer the return type, so the
 * overloads are exposed as separate, single-function ABIs.
 */
export const GATE_AGENT_ABI = [
  {
    type: "function",
    name: "checkGate",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      { name: "allowed", type: "bool" },
      { name: "score", type: "uint8" },
      { name: "reason", type: "uint8" },
    ],
  },
] as const;

export const GATE_INTENT_ABI = [
  {
    type: "function",
    name: "checkGate",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "intentHash", type: "bytes32" },
      { name: "envelopeHash", type: "bytes32" },
    ],
    outputs: [
      { name: "allowed", type: "bool" },
      { name: "score", type: "uint8" },
      { name: "reason", type: "uint8" },
    ],
  },
] as const;

export const STAKE_REGISTRY_ABI = parseAbi([
  "function stake(uint256 agentId, uint256 amount)",
  "function unstake(uint256 agentId, uint256 amount)",
  "function voluntaryExit(uint256 agentId)",
  "function slashAgent(uint256 agentId, uint8 level, address beneficiary, bytes32 evidenceHash, string reason) returns (uint256)",
  "function reactivate(uint256 agentId)",
  "function isEligible(uint256 agentId) view returns (bool)",
  "function scoreOf(uint256 agentId) view returns (uint8)",
  "function statusOf(uint256 agentId) view returns (uint8)",
  "function stakeOf(uint256 agentId) view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function minScore() view returns (uint8)",
  "function isStakedReviewer(address account) view returns (bool)",
  "event AgentSlashed(uint256 indexed agentId, uint8 level, uint256 amountSlashed, address indexed beneficiary, uint256 bounty, bytes32 evidenceHash, string reason)",
  "event Staked(uint256 indexed agentId, address indexed staker, uint256 amount, uint256 totalStake)",
]);

export const IDENTITY_REGISTRY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getMetadata(uint256 agentId, string key) view returns (bytes)",
  "function isBanned(uint256 agentId) view returns (bool)",
  "function isActive(uint256 agentId) view returns (bool)",
  "function statusOf(uint256 agentId) view returns (uint8)",
  "function registrationBond() view returns (uint256)",
  "function agentRegistry() view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function hashAgentWalletSet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const REPUTATION_REGISTRY_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function scoreOf(uint256 agentId) view returns (uint8)",
  "function gradeOf(uint256 agentId) view returns (string)",
  "function scoreUpdatedAt(uint256 agentId) view returns (uint64)",
  "function getSummary(uint256 agentId, address[] reviewers, string tag) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event ScorePosted(uint256 indexed agentId, uint8 score, string grade, uint64 updatedAt, bytes32 breakdownHash)",
]);

export const VALIDATION_REGISTRY_ABI = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function latestResponse(bytes32 requestHash) view returns (uint8)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);

export const CREDIT_MARKET_ABI = parseAbi([
  "function collateralRatioBps(uint256 agentId) view returns (uint256)",
  "function borrowCapacity(uint256 agentId) view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function totalLiquidity() view returns (uint256)",
  "function totalOutstanding() view returns (uint256)",
  "function debt(uint256 agentId) view returns (uint256)",
  "function collateral(uint256 agentId) view returns (uint256)",
  "function borrower(uint256 agentId) view returns (address)",
  "function fundLiquidity(uint256 amount)",
  "function depositCollateral(uint256 agentId, uint256 amount)",
  "function borrow(uint256 agentId, uint256 amount)",
  "function repay(uint256 agentId, uint256 amount)",
  "function liquidate(uint256 agentId)",
  "function isLiquidatable(uint256 agentId) view returns (bool)",
  "function BPS() view returns (uint16)",
  "function TIER_A_RATIO_BPS() view returns (uint16)",
  "function TIER_B_RATIO_BPS() view returns (uint16)",
  "function TIER_C_RATIO_BPS() view returns (uint16)",
  "function TIER_A_MIN_SCORE() view returns (uint8)",
  "function TIER_B_MIN_SCORE() view returns (uint8)",
  "function LIQUIDATION_INCENTIVE_BPS() view returns (uint16)",
  "event CollateralDeposited(uint256 indexed agentId, address indexed depositor, uint256 amount)",
  "event Borrowed(uint256 indexed agentId, address indexed borrower, uint256 amount, uint256 collateralRatioBps, uint8 score)",
  "event Repaid(uint256 indexed agentId, address indexed payer, uint256 amount, uint256 remainingDebt)",
  "event Liquidated(uint256 indexed agentId, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized)",
]);

/**
 * Cleanverse CVI/CVA compliance surface (Workstream 1).
 *
 * `gateCVATransfer` is called from inside `AvairaCVA._update` — it is not an optional
 * wrapper, so integrators read `previewGateCVATransfer` before attempting a movement.
 */
export const COMPLIANCE_GATE_ABI = parseAbi([
  "function verifyCVI(address wallet, bytes issuerSignature, bytes32 credentialHash)",
  "function verifyCVIWithExpiry(address wallet, bytes issuerSignature, bytes32 credentialHash, uint64 expiry, uint256 nonce)",
  "function revokeCVI(address wallet)",
  "function gateCVATransfer(address from, address to, uint256 amount)",
  "function tryGateCVATransfer(address from, address to, uint256 amount) returns (bool)",
  "function requireVerified(address wallet) view",
  "function previewGateCVATransfer(address from, address to, uint256 amount) view returns (bool allowed, uint8 fromStatus, uint8 toStatus, address blockingWallet)",
  "function recordGatedTransfer(address from, address to, uint256 amount, bool allowed)",
  "function isCVIValid(address wallet) view returns (bool)",
  "function credentialOf(address wallet) view returns (address wallet_, bytes32 credentialHash, uint64 expiry, uint8 status, address issuer, uint64 verifiedAt)",
  "function credentialStatusOf(address wallet) view returns (uint8)",
  "function credentialNonce(address wallet) view returns (uint256)",
  "function requiresCVI(string action) pure returns (bool)",
  "function defaultValidity() view returns (uint64)",
  "function gatedTransferCount() view returns (uint256)",
  "function isIssuer(address issuer) view returns (bool)",
  "function hashCVIClaim(address wallet, bytes32 credentialHash, uint256 nonce) view returns (bytes32)",
  "function hashCVIClaimWithExpiry(address wallet, bytes32 credentialHash, uint64 expiry, uint256 nonce) view returns (bytes32)",
  "function setIssuer(address issuer, bool allowed)",
  "function setDefaultValidity(uint64 newValidity)",
  "event CVIVerified(address indexed wallet, bytes32 credentialHash, uint256 expiry)",
  "event CVIRevoked(address indexed wallet, bytes32 credentialHash)",
  "event CVATransferGated(address indexed from, address indexed to, uint256 amount, bool allowed)",
  "event IssuerUpdated(address indexed issuer, bool allowed)",
]);

/** The CVI-gated CVA token. Transfers revert unless both sides hold a valid credential. */
export const CVA_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function burn(address from, uint256 amount)",
  "function complianceGate() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/**
 * Gate read that also surfaces the wallet blocking a `cva.*` intent, so a runtime can tell
 * the operator which wallet needs a Cleanverse credential.
 */
export const GATE_CVI_ABI = [
  {
    type: "function",
    name: "checkGateWithCVI",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [
      { name: "allowed", type: "bool" },
      { name: "score", type: "uint8" },
      { name: "reason", type: "uint8" },
      { name: "blocker", type: "address" },
    ],
  },
] as const;

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
