import { useState } from "react";
import { KeyRound, Link2, Loader2 } from "lucide-react";
import { DynamicWidget } from "@dynamic-labs/sdk-react-core";
import { toast } from "sonner";

import { useDynamicSession, isDynamicConfigured } from "@/components/DynamicProviderWrapper";
import { bindAgentWallet, getAgentWallet, MONAD_TESTNET } from "@/lib/web3";

const short = (addr) => (addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : "—");
const explorerTx = (hash) => `${MONAD_TESTNET.blockExplorers.default.url}/tx/${hash}`;

/**
 * Operator tooling backed by the Dynamic embedded wallet:
 * binds an agent execution wallet to an ERC-8004 identity by signing the
 * EIP-712 `AgentWalletSet` message that AvairaIdentityRegistry.setAgentWallet
 * verifies — the signature comes from the embedded wallet, not MetaMask.
 */
export default function OperatorTools() {
  const session = useDynamicSession();
  const [agentId, setAgentId] = useState("1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [boundWallet, setBoundWallet] = useState(null);

  if (!isDynamicConfigured()) return null;
  if (!session) {
    return (
      <div className="cyber-card corner-cut p-4 mb-4" data-testid="operator-tools-unavailable">
        <p className="font-mono text-[11px] text-avaira-dim">
          Dynamic is configured but failed to initialise — check REACT_APP_DYNAMIC_ENV_ID.
        </p>
      </div>
    );
  }

  const wallet = session.primaryWallet;
  const isEmbedded = !!wallet?.isEmbeddedWallet || /embedded/i.test(wallet?.walletInfo?.name ?? "");

  const handleLookup = async () => {
    try {
      const bound = await getAgentWallet(agentId);
      setBoundWallet(bound);
    } catch (err) {
      toast.error(err?.shortMessage || err.message || "Lookup failed");
    }
  };

  const handleBind = async () => {
    if (!wallet) return;
    if (!/^\d+$/.test(agentId)) return toast.error("Agent id must be a number");
    setBusy(true);
    setResult(null);
    try {
      const txHash = await bindAgentWallet({
        wallet,
        agentId,
        newWallet: wallet.address, // bind THIS embedded wallet as the agent execution wallet
      });
      setResult({ txHash });
      toast.success("Agent wallet bound on-chain");
    } catch (err) {
      toast.error(err?.shortMessage || err.message || "Binding failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cyber-card corner-cut p-4 mb-4" data-testid="operator-tools">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound size={14} className="text-avaira-primary" />
        <h2 className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider">
          Operator Tools — Dynamic Embedded Wallet
        </h2>
      </div>

      {!wallet ? (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] text-avaira-muted">
            Sign in with Dynamic to provision your embedded operator wallet — it signs the EIP-712
            agent-wallet binding directly, no MetaMask needed.
          </p>
          <div data-testid="dynamic-widget-login">
            <DynamicWidget />
          </div>
        </div>
      ) : (
        <>
          <div className="font-mono text-[11px] text-avaira-muted mb-3" data-testid="embedded-wallet-info">
            <span className="text-foreground">{short(wallet.address)}</span>
            {" · "}
            {isEmbedded ? <span className="text-[#39FF14]">EMBEDDED WALLET</span> : <span className="text-[#FFD300]">EXTERNAL WALLET</span>}
            {" · "}chain {MONAD_TESTNET.id}
          </div>

          <div className="flex flex-col md:flex-row gap-2 md:items-center">
            <input
              data-testid="bind-agent-id-input"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agent id"
              className="w-32 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
            />
            <button
              data-testid="lookup-bound-wallet-btn"
              onClick={handleLookup}
              className="px-3 py-2 border border-avaira-border text-avaira-muted font-mono text-xs uppercase hover:border-avaira-primary hover:text-avaira-primary transition-colors"
            >
              Current binding
            </button>
            <button
              data-testid="bind-wallet-btn"
              onClick={handleBind}
              disabled={busy}
              className="px-4 py-2 border border-avaira-primary text-avaira-primary font-mono text-xs uppercase tracking-wider disabled:opacity-40 hover:bg-avaira-primary/10 transition-colors inline-flex items-center gap-2"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
              {busy ? "Signing + submitting…" : "Bind this wallet as agent wallet"}
            </button>
          </div>

          {boundWallet && (
            <p className="font-mono text-[11px] text-avaira-muted mt-2" data-testid="bound-wallet-result">
              Bound execution wallet for agent #{agentId}: <span className="text-foreground">{boundWallet === "0x0000000000000000000000000000000000000000" ? "none" : short(boundWallet)}</span>
            </p>
          )}

          {result?.txHash && (
            <p className="font-mono text-[11px] text-[#39FF14] mt-2" data-testid="bind-tx-result">
              ✓ setAgentWallet confirmed —{" "}
              <a href={explorerTx(result.txHash)} target="_blank" rel="noreferrer" className="underline">
                {short(result.txHash)}
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
