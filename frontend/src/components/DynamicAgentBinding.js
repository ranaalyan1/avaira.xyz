/**
 * Operator flow: bind an agent's execution wallet with a Dynamic embedded wallet.
 *
 * This is the Workstream 2 acceptance path — log in with Dynamic, get an embedded wallet,
 * sign the EIP-712 `AgentWalletSet` message, and land `setAgentWallet` on Monad. No MetaMask
 * anywhere in the flow.
 */
import { useState } from "react";
import { Fingerprint, Loader2, Wallet, ExternalLink, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import useDynamicOperator from "@/hooks/useDynamicOperator";
import { AGENT_WALLET_SET_TYPE, CHAIN_ID, CONTRACTS, isDynamicConfigured } from "@/lib/dynamicConfig";

const shorten = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "");

/**
 * Gate: without a Dynamic environment id the provider is not mounted, so the hook must not
 * run. The fallback keeps the page informative rather than broken.
 */
export default function DynamicAgentBinding(props) {
  if (!isDynamicConfigured) {
    return (
      <section className="border border-avaira-border bg-avaira-card" data-testid="dynamic-agent-binding">
        <header className="border-b border-avaira-border px-4 py-3">
          <h2 className="font-heading text-sm tracking-wide">AGENT WALLET BINDING (DYNAMIC)</h2>
        </header>
        <p className="px-4 py-4 font-mono text-xs text-avaira-yellow">
          Set REACT_APP_DYNAMIC_ENV_ID (Dynamic dashboard → Environment ID) to enable embedded-wallet
          onboarding. The on-chain EIP-712 binding works without it — the embedded wallet does not.
        </p>
      </section>
    );
  }
  return <ConfiguredBinding {...props} />;
}

function ConfiguredBinding({ defaultAgentId = "" }) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [result, setResult] = useState(null);
  const { ready, authenticated, address, isEmbedded, connect, disconnect, bindAgentWallet, status, busy, error } =
    useDynamicOperator();

  const handleBind = async (event) => {
    event.preventDefault();
    if (!agentId) return toast.error("Enter an agent id");
    try {
      const tx = await bindAgentWallet(agentId);
      setResult(tx);
      toast.success("Agent wallet bound via Dynamic embedded wallet");
    } catch (err) {
      toast.error(err.shortMessage || err.message || "binding failed");
    }
    return undefined;
  };

  return (
    <section className="border border-avaira-border bg-avaira-card" data-testid="dynamic-agent-binding">
      <header className="flex items-center justify-between border-b border-avaira-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Fingerprint size={14} className="text-avaira-purple" />
          <h2 className="font-heading text-sm tracking-wide">AGENT WALLET BINDING (DYNAMIC)</h2>
        </div>
        <span className="font-mono text-[10px] text-avaira-dim">EIP-712 · chain {CHAIN_ID}</span>
      </header>

      <div className="px-4 py-4 space-y-4">
                {configured && !authenticated && (
          <button
            type="button"
            onClick={connect}
            disabled={!ready}
            className="cyber-btn border border-avaira-purple text-avaira-purple px-3 py-2 font-heading text-xs flex items-center gap-2"
          >
            <Wallet size={12} /> {ready ? "CONNECT DYNAMIC WALLET" : "LOADING DYNAMIC…"}
          </button>
        )}

        {authenticated && (
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="inline-flex items-center gap-1 border border-avaira-green/50 text-avaira-green px-2 py-1">
              <ShieldCheck size={11} /> {isEmbedded ? "EMBEDDED WALLET" : "EXTERNAL WALLET"}
            </span>
            <span className="text-avaira-muted">{shorten(address)}</span>
            <button type="button" onClick={disconnect} className="text-avaira-dim hover:text-avaira-muted underline">
              disconnect
            </button>
          </div>
        )}

        {authenticated && (
          <form onSubmit={handleBind} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">agent id</span>
              <input
                value={agentId}
                onChange={(event) => setAgentId(event.target.value.replace(/[^0-9]/g, ""))}
                placeholder="1"
                className="w-32 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-avaira-muted focus:border-avaira-primary outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !CONTRACTS.identityRegistry}
              className="cyber-btn border border-avaira-green text-avaira-green px-3 py-2 font-heading text-xs flex items-center gap-2 disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Fingerprint size={12} />}
              SIGN &amp; BIND
            </button>
            {!CONTRACTS.identityRegistry && (
              <span className="font-mono text-[10px] text-avaira-yellow">
                REACT_APP_IDENTITY_REGISTRY not set
              </span>
            )}
          </form>
        )}

        {status && <p className="font-mono text-[11px] text-avaira-muted">status: {status}</p>}
        {error && <p className="font-mono text-[11px] text-avaira-red">error: {error}</p>}

        {result && (
          <div className="border border-avaira-border/70 bg-avaira-bg p-3 font-mono text-[11px] space-y-1">
            <p className="text-avaira-green">agent #{String(agentId)} bound to {shorten(result.newWallet)}</p>
            <p className="text-avaira-dim">nonce {result.nonce?.toString()} · adapter {result.adapter}</p>
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-avaira-data hover:underline"
            >
              {shorten(result.txHash)} <ExternalLink size={10} />
            </a>
          </div>
        )}

        <details className="font-mono text-[10px] text-avaira-dim">
          <summary className="cursor-pointer text-avaira-muted">EIP-712 message the embedded wallet signs</summary>
          <pre className="mt-2 whitespace-pre-wrap">
{JSON.stringify(
  {
    domain: { ...(process.env.REACT_APP_IDENTITY_DOMAIN || { name: "AvairaIdentityRegistry", version: "1" }), chainId: CHAIN_ID },
    types: AGENT_WALLET_SET_TYPE,
    primaryType: "AgentWalletSet",
    message: { agentId: "<id>", newWallet: "<embedded wallet>", nonce: "<chain nonce>", deadline: "<now+1h>" },
  },
  null,
  2,
)}
          </pre>
        </details>
      </div>
    </section>
  );
}
