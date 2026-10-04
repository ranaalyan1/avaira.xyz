/**
 * Dynamic (docs.dynamic.xyz) configuration — Workstream 2.
 *
 * The embedded wallet is the operator/underwriter identity: there is no browser extension to
 * install, and the same key signs the EIP-712 `AgentWalletSet` binding that
 * `AvairaIdentityRegistry.setAgentWallet` requires plus collateral deposits into the credit
 * market.
 *
 * `REACT_APP_DYNAMIC_ENV_ID` comes from the Dynamic dashboard. When it is absent the app
 * still runs: every Dynamic-powered action degrades to a clear "not configured" state
 * instead of crashing the bundle.
 */
export const DYNAMIC_ENV_ID = process.env.REACT_APP_DYNAMIC_ENV_ID || "";

export const isDynamicConfigured = Boolean(DYNAMIC_ENV_ID);

export const CHAIN_ID = Number(
  process.env.REACT_APP_CHAIN_ID || process.env.REACT_APP_MONAD_CHAIN_ID || 10143,
);

/** On-chain addresses. Empty defaults keep the UI honest rather than silently wrong. */
export const CONTRACTS = {
  identityRegistry: process.env.REACT_APP_IDENTITY_REGISTRY || "",
  stakeRegistry: process.env.REACT_APP_STAKE_REGISTRY || "",
  creditMarket: process.env.REACT_APP_CREDIT_MARKET || "",
  settlementToken: process.env.REACT_APP_SETTLEMENT_TOKEN || "",
  intentVault: process.env.REACT_APP_INTENT_VAULT || "",
  complianceGate: process.env.REACT_APP_COMPLIANCE_GATE || "",
  cvaToken: process.env.REACT_APP_CVA_TOKEN || "",
};

export const RPC_URL =
  process.env.REACT_APP_MONAD_RPC ||
  process.env.REACT_APP_RPC_URL ||
  "https://testnet-rpc.monad.xyz";

export const EXPLORER_URL = process.env.REACT_APP_EXPLORER_URL || "https://testnet.monadscan.com";

/** EIP-712 domain/types shared by the binding and collateral flows. */
export const IDENTITY_DOMAIN = {
  name: "AvairaIdentityRegistry",
  version: "1",
};

export const AGENT_WALLET_SET_TYPE = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
