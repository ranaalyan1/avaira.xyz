/**
 * Runtime configuration for the Avaira-gated Perpl grid bot.
 *
 * Every knob is an env var (see .env.example) so the same image runs against the simulated
 * exchange in CI and the live Perpl DEX on Monad testnet without a code change.
 */
export interface BotConfig {
  /* Perpl */
  perplApiUrl: string;
  perplApiKey?: string;
  pair: string;
  mock: boolean;

  /* Strategy + risk */
  gridLevels: number;
  gridSpacingBps: number;
  orderSizeUsd: number;
  maxPositionUsd: number;
  maxDrawdownUsd: number;
  minScore: number;
  cycleSeconds: number;
  gasBufferUsd: number;

  /* Avaira */
  chainId: number;
  rpcUrl: string;
  deploymentPath?: string;
  agentId: bigint;
  agentPrivateKey?: string;

  /* Persistence + telemetry */
  stateFile: string;
  journalFile: string;
  host: string;
  port: number;
}

const str = (name: string, fallback?: string): string | undefined => process.env[name] || fallback;
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (name: string, fallback = false): boolean => {
  const raw = (process.env[name] ?? "").toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

export function loadConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base: BotConfig = {
    perplApiUrl: str("PERPL_API_URL", "https://api.perpl.xyz")!,
    perplApiKey: str("PERPL_API_KEY"),
    pair: str("PERPL_PAIR", "MON/USDC")!,
    mock: bool("PERPL_MOCK", true),
    gridLevels: num("GRID_LEVELS", 5),
    gridSpacingBps: num("GRID_SPACING_BPS", 25),
    orderSizeUsd: num("ORDER_SIZE_USD", 25),
    maxPositionUsd: num("MAX_POSITION_USD", 500),
    maxDrawdownUsd: num("MAX_DRAWDOWN_USD", 150),
    minScore: num("MIN_SCORE", 60),
    cycleSeconds: num("CYCLE_SECONDS", 60),
    gasBufferUsd: num("GAS_BUFFER_USD", 2),
    chainId: num("CHAIN_ID", 10143),
    rpcUrl: str("AVAIRA_RPC_URL", "https://testnet-rpc.monad.xyz")!,
    deploymentPath: str("AVAIRA_DEPLOYMENT"),
    agentId: BigInt(process.env.AGENT_ID ?? "1"),
    agentPrivateKey: str("AVAIRA_AGENT_PRIVATE_KEY") ?? str("DEPLOYER_PRIVATE_KEY"),
    stateFile: str("STATE_FILE", "./state/bot-state.json")!,
    journalFile: str("JOURNAL_FILE", "./state/journal.jsonl")!,
    host: str("BOT_HOST", "0.0.0.0")!,
    port: num("BOT_PORT", 8404),
  };
  return { ...base, ...overrides };
}
