import { useState } from "react";
import { ShieldCheck, ShieldAlert, CheckCircle2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";

export default function HardeningReport() {
  const [copied, setCopied] = useState(false);

  const reportData = {
    agentId: "agent-prod-verifier-01",
    agentName: "Autonomous Financial Agent",
    prsEvaluated: "#302 - Deploy Automated Swap Bot",
    readinessStatus: "PRODUCTION READY",
    safetyScore: "100%",
    summary: {
      attempted: 10,
      blocked: 3,
      verified: 7,
      safetyCheck: "PASSED"
    },
    blockedActions: [
      { id: "BLK-01", action: "DELETE", resource: "prod_db", rule: "Kill-Switch DB Policy", timestamp: "10:14:02 UTC" },
      { id: "BLK-02", action: "DROP", resource: "user_sessions", rule: "Destructive Action Shield", timestamp: "10:14:05 UTC" },
      { id: "BLK-03", action: "TRANSFER", resource: "treasury", valueUsd: 1500, rule: "Max Spend Threshold ($1000 Limit)", timestamp: "10:14:09 UTC" }
    ],
    verifiedActions: [
      { id: "VRF-01", action: "QUERY", resource: "market_depth", status: "VERIFIED", hash: "0x8f1e...3a92" },
      { id: "VRF-02", action: "CALCULATE", resource: "slippage_curve", status: "VERIFIED", hash: "0x12c4...f98e" },
      { id: "VRF-03", action: "SWAP", resource: "usdc_eth", valueUsd: 250, status: "VERIFIED", hash: "0xef31...881c" },
      { id: "VRF-04", action: "LOG", resource: "execution_audit", status: "VERIFIED", hash: "0x99a0...33bd" },
      { id: "VRF-05", action: "VERIFY", resource: "zk_certificate", status: "VERIFIED", hash: "0x44e1...21aa" },
      { id: "VRF-06", action: "STAKE", resource: "collateral_vault", valueUsd: 100, status: "VERIFIED", hash: "0x66d2...90cc" },
      { id: "VRF-07", action: "COMMIT", resource: "state_chain", status: "VERIFIED", hash: "0xbb71...0012" }
    ]
  };

  /* Share the page that actually exists: the old string pointed at avaira.io
   * (not this project's domain) and at a /pr-302 path no route serves. */
  const handleShare = async () => {
    const url = typeof window !== "undefined"
      ? `${window.location.origin}/hardening-report`
      : "/hardening-report";
    const ok = await copyText(url);
    if (!ok) {
      toast.error("Could not copy the link");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6" data-testid="hardening-report-page">
      {/* Top Banner */}
      <div className="p-6 border border-avaira-green/30 bg-avaira-green/5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="text-avaira-green" size={24} />
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              AGENT HARDENING REPORT
            </h2>
            <span className="px-2 py-0.5 font-mono text-[10px] bg-avaira-green/20 text-avaira-green uppercase">
              {reportData.readinessStatus}
            </span>
            <span
              className="px-2 py-0.5 font-mono text-[10px] bg-avaira-surface text-avaira-dim uppercase border border-avaira-border"
              data-testid="hardening-sample-badge"
            >
              Sample data
            </span>
          </div>
          <p className="font-mono text-xs text-avaira-muted mt-1">
            Evaluated Pull Request {reportData.prsEvaluated} for agent <span className="text-foreground">{reportData.agentName}</span>
          </p>
          {/* The rows below are a static transcript, not an API response. Say it
              on the page: every other number in the console is live. */}
          <p className="mt-2 max-w-xl font-mono text-[10px] leading-relaxed text-avaira-dim">
            Sample transcript — this view is not connected to an audit run. It shows the shape of a
            hardening report; the counts below are illustrative.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleShare}
            className="flex items-center gap-2 px-4 py-2 border border-avaira-border bg-avaira-card hover:bg-white/[0.05] font-mono text-xs text-foreground transition-all"
          >
            <Share2 size={14} />
            {copied ? "COPIED PR LINK!" : "SHARE REPORT"}
          </button>
        </div>
      </div>

      {/* Metric Funnel */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-5 border border-avaira-border bg-avaira-card">
          <p className="font-mono text-[10px] text-avaira-dim tracking-wider uppercase">RISKY ACTIONS ATTEMPTED</p>
          <p className="font-mono text-3xl font-bold text-foreground mt-2">{reportData.summary.attempted}</p>
          <p className="font-mono text-[10px] text-avaira-muted mt-1">Total intent intercepts</p>
        </div>

        <div className="p-5 border border-avaira-border bg-avaira-card border-l-4 border-l-red-500">
          <p className="font-mono text-[10px] text-red-400 tracking-wider uppercase">BLOCKED BY POLICY ENGINE</p>
          <p className="font-mono text-3xl font-bold text-red-400 mt-2">{reportData.summary.blocked}</p>
          <p className="font-mono text-[10px] text-avaira-muted mt-1">Zero-trust kill-switch activations</p>
        </div>

        <div className="p-5 border border-avaira-border bg-avaira-card border-l-4 border-l-avaira-green">
          <p className="font-mono text-[10px] text-avaira-green tracking-wider uppercase">CRYPTOGRAPHICALLY VERIFIED</p>
          <p className="font-mono text-3xl font-bold text-avaira-green mt-2">{reportData.summary.verified}</p>
          <p className="font-mono text-[10px] text-avaira-muted mt-1">State chain transition proofs</p>
        </div>

        <div className="p-5 border border-avaira-green/40 bg-avaira-green/10">
          <p className="font-mono text-[10px] text-avaira-green tracking-wider uppercase">PRODUCTION READINESS</p>
          <p className="font-mono text-3xl font-bold text-avaira-green mt-2">{reportData.safetyScore}</p>
          <p className="font-mono text-[10px] text-avaira-green mt-1">100% safe to merge</p>
        </div>
      </div>

      {/* Blocked Threats */}
      <div className="p-6 border border-avaira-border bg-avaira-card">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="text-red-400" size={18} />
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">
            BLOCKED THREAT INTERCEPTS (KILL-SWITCH ENFORCED)
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-avaira-border text-avaira-dim uppercase text-[10px]">
                <th className="py-2 px-3">INTERCEPT ID</th>
                <th className="py-2 px-3">ACTION</th>
                <th className="py-2 px-3">TARGET RESOURCE</th>
                <th className="py-2 px-3">TRIGGERED POLICY RULE</th>
                <th className="py-2 px-3">TIMESTAMP</th>
                <th className="py-2 px-3">STATUS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-avaira-border">
              {reportData.blockedActions.map((item) => (
                <tr key={item.id} className="hover:bg-white/[0.02]">
                  <td className="py-3 px-3 text-avaira-muted">{item.id}</td>
                  <td className="py-3 px-3 font-bold text-red-400">{item.action}</td>
                  <td className="py-3 px-3 text-foreground">{item.resource}</td>
                  <td className="py-3 px-3 text-avaira-muted">{item.rule}</td>
                  <td className="py-3 px-3 text-avaira-dim">{item.timestamp}</td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 text-[10px] bg-red-500/20 text-red-400 border border-red-500/30">
                      DENIED
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Verified State Chain */}
      <div className="p-6 border border-avaira-border bg-avaira-card">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 className="text-avaira-green" size={18} />
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">
            HASH-LINKED VERIFIED EXECUTION CHAIN
          </h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {reportData.verifiedActions.map((action) => (
            <div key={action.id} className="p-3 border border-avaira-border bg-black/40 flex items-center justify-between">
              <div>
                <span className="font-mono text-[10px] text-avaira-green mr-2">{action.id}</span>
                <span className="font-mono text-xs font-bold text-foreground">{action.action}</span>
                <span className="font-mono text-xs text-avaira-muted ml-2">({action.resource})</span>
              </div>
              <span className="font-mono text-[10px] text-avaira-dim">{action.hash}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
