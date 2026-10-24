import { useState, useEffect } from "react";
import { Activity, ShieldCheck, TrendingUp, AlertCircle, Terminal } from "lucide-react";

import { DARK } from "@/lib/palette";

export default function TrustHeatmap({ agentId }) {
  const [drift, setDrift] = useState({ score: 0.1, trend: "stable" });
  const [logs, setLogs] = useState([]);

  // Mock real-time decision traces
  useEffect(() => {
    const interval = setInterval(() => {
      const newTrace = {
        id: Math.random().toString(36).slice(2, 11),
        intent: "Search DeFi yield benchmarks",
        status: Math.random() > 0.1 ? "approved" : "flagged",
        timestamp: new Date().toLocaleTimeString(),
      };
      setLogs(prev => [newTrace, ...prev].slice(0, 10));

      // Randomly simulate behavioral drift
      if (Math.random() > 0.8) {
        setDrift({
          score: Math.random(),
          trend: Math.random() > 0.5 ? "deviating" : "stable"
        });
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="cyber-card p-4 mt-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-muted flex items-center gap-2">
          <ShieldCheck size={14} className="text-avaira-primary" /> Sentinel Trust Heatmap
          {/* This panel is a local simulation: there is no /sentinel endpoint in
              the API, so the traces below are generated in the browser. Say so
              rather than presenting synthetic rows as protocol activity. */}
          <span className="rounded border border-avaira-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-avaira-dim">
            sample feed
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-avaira-muted">Behavioral Drift:</span>
          <div className="h-2 w-24 bg-avaira-surface relative overflow-hidden">
            <div
              className="h-full bg-avaira-primary transition-all duration-500"
              style={{
                width: `${drift.score * 100}%`,
                background: drift.score > 0.6 ? DARK.danger : drift.score > 0.3 ? DARK.warning : DARK.info
              }}
            />
          </div>
          <span className={`font-mono text-[10px] uppercase ${drift.trend === 'deviating' ? 'text-avaira-red' : 'text-avaira-muted'}`}>
            {drift.trend}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Real-time Decision Traces */}
        <div className="bg-black/20 p-3 border border-white/5 rounded">
          <p className="font-mono text-[10px] text-avaira-dim mb-2 uppercase">Live Decision Traces</p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {logs.map((log) => (
              <div key={log.id} className="flex justify-between items-center text-[10px] font-mono border-b border-white/5 pb-1">
                <span className="text-foreground truncate max-w-[150px]">{log.intent}</span>
                <div className="flex items-center gap-2">
                  <span className={log.status === 'approved' ? 'text-avaira-primary' : 'text-avaira-red'}>
                    {log.status.toUpperCase()}
                  </span>
                  <span className="text-avaira-dim">{log.timestamp}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Natural Language Audit Query (Mock) */}
        <div className="bg-black/20 p-3 border border-white/5 rounded">
          <p className="font-mono text-[10px] text-avaira-dim mb-2 uppercase">Semantic Audit Console</p>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="Query audit logs..."
              className="bg-transparent border border-white/10 px-2 py-1 text-[10px] font-mono flex-1 focus:outline-none focus:border-avaira-primary"
            />
            <button className="cyber-btn px-2 py-1 text-[8px] bg-avaira-surface border border-white/10 hover:border-avaira-primary">
              ASK SENTINEL
            </button>
          </div>
          <div className="p-2 border border-avaira-primary/20 bg-avaira-primary/5 rounded">
            <p className="font-mono text-[9px] text-avaira-muted leading-relaxed italic">
              "Sentinel Analysis: Agent shows 12% drift towards aggressive asset rotation but remains within Risk Envelope. No immediate intervention required."
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
