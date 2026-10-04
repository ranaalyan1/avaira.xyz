import { useState } from "react";
import { Landmark, Loader2, PiggyBank, HandCoins } from "lucide-react";
import { DynamicWidget } from "@dynamic-labs/sdk-react-core";
import { toast } from "sonner";

import { useDynamicSession, isDynamicConfigured } from "@/components/DynamicProviderWrapper";
import { depositCollateral, claimPendingWithdrawals, MONAD_TESTNET } from "@/lib/web3";

const short = (addr) => (addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : "—");
const explorerTx = (hash) => `${MONAD_TESTNET.blockExplorers.default.url}/tx/${hash}`;

/**
 * Underwriter capital actions via the Dynamic embedded wallet:
 *   - depositCollateral on AvairaCreditMarket (approve USDC → deposit)
 *   - claim accrued native payouts (bond refunds / escrowed bounties)
 */
export default function UnderwriterTools() {
  const session = useDynamicSession();
  const [agentId, setAgentId] = useState("1");
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(null);
  const [lastTx, setLastTx] = useState(null);

  if (!isDynamicConfigured()) return null;
  if (!session) return null;

  const wallet = session.primaryWallet;

  const handleDeposit = async () => {
    if (!wallet) return;
    if (!/^\d+$/.test(agentId)) return toast.error("Agent id must be a number");
    if (!(parseFloat(amount) > 0)) return toast.error("Amount must be positive");
    setBusy("deposit");
    setLastTx(null);
    try {
      const txHash = await depositCollateral({ wallet, agentId, amountUsdc: amount });
      setLastTx({ label: `depositCollateral(${agentId}, ${amount} USDC)`, txHash });
      toast.success("Collateral deposited");
    } catch (err) {
      toast.error(err?.shortMessage || err.message || "Deposit failed");
    } finally {
      setBusy(null);
    }
  };

  const handleClaim = async () => {
    if (!wallet) return;
    setBusy("claim");
    setLastTx(null);
    try {
      const { txHash, claimed } = await claimPendingWithdrawals({ wallet });
      if (!txHash) {
        toast.info("Nothing to claim for this wallet");
      } else {
        setLastTx({ label: `withdrew ${claimed} MON of accrued payouts`, txHash });
        toast.success("Claim confirmed");
      }
    } catch (err) {
      toast.error(err?.shortMessage || err.message || "Claim failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cyber-card corner-cut p-4 mb-4" data-testid="underwriter-tools">
      <div className="flex items-center gap-2 mb-3">
        <Landmark size={14} className="text-avaira-primary" />
        <h2 className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider">
          Underwriter Capital — Embedded Wallet
        </h2>
      </div>

      {!wallet ? (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] text-avaira-muted">
            Connect via Dynamic to deposit collateral and claim bounties with your embedded wallet.
          </p>
          <div data-testid="dynamic-widget-underwriters">
            <DynamicWidget />
          </div>
        </div>
      ) : (
        <>
          <p className="font-mono text-[11px] text-avaira-muted mb-3">
            Signing wallet: <span className="text-foreground">{short(wallet.address)}</span>
            {wallet.isEmbeddedWallet ? <span className="text-[#39FF14]"> · EMBEDDED</span> : ""}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-[8rem_10rem_1fr_1fr] gap-2 md:items-center">
            <input
              data-testid="uw-agent-id-input"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agent id"
              className="bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
            />
            <input
              data-testid="uw-amount-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="USDC amount"
              className="bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
            />
            <button
              data-testid="deposit-collateral-btn"
              onClick={handleDeposit}
              disabled={busy !== null}
              className="px-4 py-2 border border-avaira-primary text-avaira-primary font-mono text-xs uppercase tracking-wider disabled:opacity-40 hover:bg-avaira-primary/10 transition-colors inline-flex items-center justify-center gap-2"
            >
              {busy === "deposit" ? <Loader2 size={12} className="animate-spin" /> : <PiggyBank size={12} />}
              Deposit collateral
            </button>
            <button
              data-testid="claim-bounty-btn"
              onClick={handleClaim}
              disabled={busy !== null}
              className="px-4 py-2 border border-avaira-border text-avaira-muted font-mono text-xs uppercase tracking-wider disabled:opacity-40 hover:border-avaira-primary hover:text-avaira-primary transition-colors inline-flex items-center justify-center gap-2"
            >
              {busy === "claim" ? <Loader2 size={12} className="animate-spin" /> : <HandCoins size={12} />}
              Claim accrued payouts
            </button>
          </div>

          {lastTx?.txHash && (
            <p className="font-mono text-[11px] text-[#39FF14] mt-2" data-testid="uw-last-tx">
              ✓ {lastTx.label} —{" "}
              <a href={explorerTx(lastTx.txHash)} target="_blank" rel="noreferrer" className="underline">
                {short(lastTx.txHash)}
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
