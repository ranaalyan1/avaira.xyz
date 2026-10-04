/**
 * Underwriter flow: deposit collateral (and read the resulting position) from a Dynamic
 * embedded wallet — the second Workstream 2 acceptance criterion.
 */
import { useCallback, useEffect, useState } from "react";
import { Coins, Loader2, ExternalLink, RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";

import useDynamicOperator from "@/hooks/useDynamicOperator";
import { CHAIN_ID, CONTRACTS, isDynamicConfigured } from "@/lib/dynamicConfig";

const shorten = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "");

/** Gate: see DynamicAgentBinding — the Dynamic hook only runs under its provider. */
export default function DynamicCollateralCard(props) {
  if (!isDynamicConfigured) {
    return (
      <section className="border border-avaira-border bg-avaira-card" data-testid="dynamic-collateral-card">
        <header className="border-b border-avaira-border px-4 py-3">
          <h2 className="font-heading text-sm tracking-wide">COLLATERAL VIA DYNAMIC WALLET</h2>
        </header>
        <p className="px-4 py-4 font-mono text-xs text-avaira-yellow">
          Set REACT_APP_DYNAMIC_ENV_ID to enable embedded-wallet collateral deposits
          (approve + depositCollateral on the credit market).
        </p>
      </section>
    );
  }
  return <ConfiguredCollateral {...props} />;
}

function ConfiguredCollateral({ defaultAgentId = "" }) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [amount, setAmount] = useState("1000");
  const [position, setPosition] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const {
    ready,
    authenticated,
    address,
    isEmbedded,
    connect,
    depositCollateral,
    readCollateralPosition,
    status,
    busy,
    error,
  } = useDynamicOperator();

  const refresh = useCallback(async () => {
    if (!agentId || !CONTRACTS.creditMarket) return;
    try {
      setPosition(await readCollateralPosition(agentId));
    } catch (err) {
      toast.error(err.shortMessage || err.message || "could not read the position");
    }
  }, [agentId, readCollateralPosition]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDeposit = async (event) => {
    event.preventDefault();
    if (!agentId) return toast.error("Enter an agent id");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return toast.error("Enter a positive USDC amount (6 decimals)");
    try {
      const result = await depositCollateral(agentId, Math.round(value * 1e6));
      setTxHash(result.txHash);
      toast.success("Collateral deposited via Dynamic embedded wallet");
      refresh();
    } catch (err) {
      toast.error(err.shortMessage || err.message || "deposit failed");
    }
    return undefined;
  };

  return (
    <section className="border border-avaira-border bg-avaira-card" data-testid="dynamic-collateral-card">
      <header className="flex items-center justify-between border-b border-avaira-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Coins size={14} className="text-avaira-data" />
          <h2 className="font-heading text-sm tracking-wide">COLLATERAL VIA DYNAMIC WALLET</h2>
        </div>
        <span className="font-mono text-[10px] text-avaira-dim">credit market · chain {CHAIN_ID}</span>
      </header>

      <div className="px-4 py-4 space-y-4">
                {configured && !authenticated && (
          <button
            type="button"
            onClick={connect}
            disabled={!ready}
            className="cyber-btn border border-avaira-data text-avaira-data px-3 py-2 font-heading text-xs flex items-center gap-2"
          >
            <Wallet size={12} /> {ready ? "CONNECT DYNAMIC WALLET" : "LOADING DYNAMIC…"}
          </button>
        )}

        {authenticated && (
          <>
            <p className="font-mono text-[11px] text-avaira-muted">
              depositing from <span className="text-avaira-data">{shorten(address)}</span>
              {isEmbedded ? " (embedded)" : " (external)"}
            </p>

            <form onSubmit={handleDeposit} className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">agent id</span>
                <input
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value.replace(/[^0-9]/g, ""))}
                  className="w-28 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-avaira-muted focus:border-avaira-primary outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">amount (usdc)</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="w-32 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-avaira-muted focus:border-avaira-primary outline-none"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !CONTRACTS.creditMarket || !CONTRACTS.settlementToken}
                className="cyber-btn border border-avaira-green text-avaira-green px-3 py-2 font-heading text-xs flex items-center gap-2 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Coins size={12} />}
                DEPOSIT
              </button>
              <button
                type="button"
                onClick={refresh}
                className="border border-avaira-border text-avaira-muted px-3 py-2 font-heading text-xs flex items-center gap-1.5"
              >
                <RefreshCw size={12} /> POSITION
              </button>
            </form>

            {position && (
              <p className="font-mono text-[11px] text-avaira-muted">
                collateral {(Number(position.collateral) / 1e6).toLocaleString()} USDC · debt{" "}
                {(Number(position.debt) / 1e6).toLocaleString()} USDC · ratio{" "}
                {position.ratioBps ? `${position.ratioBps / 100}%` : "—"}
              </p>
            )}

            {status && <p className="font-mono text-[11px] text-avaira-muted">status: {status}</p>}
            {error && <p className="font-mono text-[11px] text-avaira-red">error: {error}</p>}

            {txHash && (
              <a
                href={`${process.env.REACT_APP_EXPLORER_URL || "https://testnet.monadscan.com"}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] text-avaira-data hover:underline"
              >
                deposit tx {shorten(txHash)} <ExternalLink size={10} />
              </a>
            )}

            {!CONTRACTS.creditMarket || !CONTRACTS.settlementToken ? (
              <p className="font-mono text-[10px] text-avaira-yellow">
                REACT_APP_CREDIT_MARKET / REACT_APP_SETTLEMENT_TOKEN are not set for this build.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
