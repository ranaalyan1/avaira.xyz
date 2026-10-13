import { useEffect, useState } from "react";
import axios from "axios";
import { Code, Shield, FileKey, Snowflake, Wallet, TrendingUp, Heart, ChevronDown, ChevronRight, AlertTriangle, Zap } from "lucide-react";

import { API } from "@/lib/api";

const CONTRACT_ICONS = {
  AgentRegistry: Shield,
  ExecutionWallet: FileKey,
  FreezeSlash: Snowflake,
  Treasury: Wallet,
  ReputationEngine: TrendingUp,
  InsurancePool: Heart,
};

const ContractCard = ({ contract }) => {
  const [expanded, setExpanded] = useState(false);
  const Icon = CONTRACT_ICONS[contract.name] || Code;

  return (
    <div className="cyber-card" data-testid={`contract-${contract.name}`}>
      <button
        data-testid={`toggle-contract-${contract.name}`}
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 border border-avaira-primary/30 bg-avaira-primary/5">
            <Icon size={16} className="text-avaira-primary" strokeWidth={1.5} />
          </div>
          <div>
            <h3 className="text-base font-semibold tracking-tight text-foreground">{contract.name}</h3>
            <div className="mt-0.5 max-w-[300px]">
              {contract.address && !contract.address.startsWith("Not") ? (
                <a
                  href={`https://testnet.snowtrace.io/address/${contract.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-avaira-primary hover:underline break-all"
                >
                  {contract.address} ->
                </a>
              ) : (
                <span className="font-mono text-xs text-avaira-dim">{contract.address || "Not deployed"}</span>
              )}
            </div>
          </div>
        </div>
        {expanded ? <ChevronDown size={16} className="text-avaira-primary" /> : <ChevronRight size={16} className="text-avaira-muted" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-avaira-border pt-4 animate-slide-in">
          <p className="font-mono text-xs text-avaira-muted">{contract.description}</p>

          {/* State variables */}
          <div>
            <h4 className="text-[11px] font-semibold tracking-tight text-avaira-primary mb-2">State variables</h4>
            <div className="space-y-1">
              {contract.state_variables.map((sv, i) => (
                <div key={i} className="flex items-start gap-2 p-1.5 bg-black/40">
                  <code className="font-mono text-[11px] text-avaira-green whitespace-nowrap">{sv.type}</code>
                  <code className="font-mono text-[11px] text-foreground">{sv.name}</code>
                  <span className="font-mono text-[10px] text-avaira-dim ml-auto">{sv.description}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Functions */}
          <div>
            <h4 className="text-[11px] font-semibold tracking-tight text-avaira-primary mb-2">Functions</h4>
            <div className="space-y-1.5">
              {contract.functions.map((fn, i) => (
                <div key={i} className="p-2 bg-black/40 border-l-2 border-avaira-primary/30">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="font-mono text-[11px] text-avaira-primary font-bold">{fn.name}</code>
                    <code className="font-mono text-[10px] text-avaira-muted">{fn.params}</code>
                    {fn.modifier && (
                      <span className="font-mono text-[9px] px-1 py-0.5 border border-avaira-purple/30 text-avaira-purple">{fn.modifier}</span>
                    )}
                  </div>
                  {fn.returns && <p className="font-mono text-[10px] text-avaira-green mt-0.5">returns {fn.returns}</p>}
                  <p className="font-mono text-[10px] text-avaira-dim mt-0.5">{fn.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Events */}
          <div>
            <h4 className="text-[11px] font-semibold tracking-tight text-avaira-primary mb-2">Events</h4>
            <div className="space-y-1">
              {contract.events.map((ev, i) => (
                <div key={i} className="p-1.5 bg-black/40">
                  <code className="font-mono text-[10px] text-avaira-yellow break-all">{ev}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default function SmartContracts() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios.get(`${API}/contracts`)
      .then(res => { setData(res.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <p className="font-mono text-xs text-avaira-muted animate-glow-pulse">Loading contract data…</p>
    </div>
  );

  return (
    <div className="page-shell animate-slide-in" data-testid="smart-contracts-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Smart Contracts</h1>
          <p className="page-subtitle">Avalanche Fuji C-Chain architecture</p>
        </div>
      </div>

      {/* Contracts */}
      {data && (
        <div className="space-y-3 mb-6">
          {data.contracts.map(contract => <ContractCard key={contract.name} contract={contract} />)}
        </div>
      )}

      {/* Security & Gas */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="cyber-card p-4">
            <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-green mb-3 flex items-center gap-2">
              <Shield size={14} /> Security Assumptions
            </h2>
            <div className="space-y-2">
              {data.security_assumptions.map((sa, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="font-mono text-[10px] text-avaira-green mt-0.5">{'>'}</span>
                  <p className="font-mono text-[11px] text-foreground">{sa}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="cyber-card p-4">
            <h2 className="text-[13px] font-semibold tracking-tight text-avaira-red mb-3 flex items-center gap-2">
              <AlertTriangle size={14} /> Attack Surfaces
            </h2>
            <div className="space-y-2">
              {data.attack_surfaces.map((as2, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="font-mono text-[10px] text-avaira-red mt-0.5">!</span>
                  <p className="font-mono text-[11px] text-foreground">{as2}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="cyber-card p-4">
            <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-yellow mb-3 flex items-center gap-2">
              <Zap size={14} /> Gas Considerations
            </h2>
            <div className="space-y-2">
              {data.gas_considerations.map((gc, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="font-mono text-[10px] text-avaira-yellow mt-0.5">~</span>
                  <p className="font-mono text-[11px] text-foreground">{gc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
