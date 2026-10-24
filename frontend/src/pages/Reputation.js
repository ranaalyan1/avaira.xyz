import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { TrendingUp, Trophy, ArrowUp, ArrowDown, Minus, RefreshCw } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

import { API } from "@/lib/api";

import ConsoleError from "@/components/ConsoleError";
import { DARK } from "@/lib/palette";
import { num, text, toNumber } from "@/lib/format";

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-avaira-card border border-avaira-border p-2 font-mono text-xs">
        {payload.map((p, i) => <p key={i} style={{ color: p.fill || p.color }}>{p.name}: {p.value}</p>)}
      </div>
    );
  }
  return null;
};

const getRepColor = (score) => {
  if (score >= 100) return DARK.success;
  if (score >= 80) return DARK.info;
  if (score >= 50) return DARK.warning;
  return DARK.danger;
};

export default function Reputation() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [lbRes, histRes] = await Promise.all([
        axios.get(`${API}/reputation/leaderboard`),
        axios.get(`${API}/reputation/history`)
      ]);
      setLeaderboard(lbRes.data);
      setHistory(histRes.data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e?.message || "The reputation API did not respond.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const chartData = leaderboard.slice(0, 10).map(a => {
    const score = toNumber(a.reputation);
    return {
      name: text(a.name, "unnamed").length > 10 ? `${text(a.name, "unnamed").slice(0, 10)}...` : text(a.name, "unnamed"),
      score: score === null ? 0 : score,
      fill: getRepColor(score === null ? 0 : score)
    };
  });

  return (
    <div className="page-shell animate-slide-in" data-testid="reputation-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reputation Engine</h1>
          <p className="page-subtitle">Agent trust scores</p>
        </div>
        <button data-testid="refresh-reputation-btn" onClick={fetchData} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
          <RefreshCw size={14} />
        </button>
      </div>

      <ConsoleError
        message={loadError}
        onRetry={fetchData}
        title="Reputation data unavailable"
        testid="reputation-error"
      />

      {loading && leaderboard.length === 0 && history.length === 0 ? (
        <div className="cyber-card p-12 text-center mb-4">
          <TrendingUp size={40} className="text-avaira-dim mx-auto mb-3 animate-glow-pulse" strokeWidth={1} />
          <p className="text-[15px] font-medium text-avaira-muted">Loading reputation data</p>
          <p className="font-mono text-xs text-avaira-dim mt-1">Fetching leaderboard scores and change history</p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Leaderboard */}
        <div className="lg:col-span-2 cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3 flex items-center gap-2">
            <Trophy size={14} className="text-avaira-yellow" /> Leaderboard
          </h2>
          {leaderboard.length === 0 ? (
            <p className="font-mono text-xs text-avaira-dim text-center py-8">NO AGENTS</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">Executions</th>
                    <th className="text-right">Success Rate</th>
                    <th className="text-right">Collateral</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((agent, i) => {
                    const executions = toNumber(agent.total_executions) || 0;
                    const successful = toNumber(agent.successful_executions) || 0;
                    const rate = executions > 0 ? ((successful / executions) * 100).toFixed(0) : '-';
                    return (
                      <tr key={agent.id} data-testid={`lb-row-${i}`}>
                        <td className="text-avaira-dim">{i + 1}</td>
                        <td className="text-foreground font-semibold">{text(agent.name, "unnamed")}</td>
                        <td>
                          <span className={`status-dot ${agent.status === 'active' ? 'active' : agent.status === 'frozen' ? 'frozen' : 'paused'}`} />
                        </td>
                        <td className="text-right">
                          <span className="font-bold" style={{ color: getRepColor(toNumber(agent.reputation) ?? 0) }}>
                            {num(agent.reputation, 0)}
                          </span>
                        </td>
                        <td className="text-right text-foreground">{text(agent.total_executions, "0")}</td>
                        <td className="text-right" style={{ color: rate !== '-' && parseInt(rate) >= 80 ? DARK.success : rate !== '-' && parseInt(rate) >= 50 ? DARK.warning : rate === '-' ? DARK.textMuted : DARK.danger }}>
                          {rate}{rate !== '-' ? '%' : ''}
                        </td>
                        <td className="text-right text-avaira-primary">{num(agent.collateral_remaining, 2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Score Chart + History */}
        <div className="space-y-4">
          {/* Bar Chart */}
          <div className="cyber-card p-4">
            <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Score distribution</h2>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={DARK.hairline} horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: DARK.textMuted, fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  <YAxis dataKey="name" type="category" width={80} tick={{ fill: DARK.textMuted, fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="score" name="Reputation" radius={[0, 2, 2, 0]}>
                    {chartData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-48 flex items-center justify-center">
                <p className="font-mono text-xs text-avaira-dim">NO DATA</p>
              </div>
            )}
          </div>

          {/* Recent changes */}
          <div className="cyber-card p-4">
            <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Recent changes</h2>
            {history.length === 0 ? (
              <p className="font-mono text-xs text-avaira-dim text-center py-6">NO HISTORY</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {history.slice(0, 15).map(h => {
                  /* A zero-delta row is a level score, not a fall — it used to
                   * render a red down arrow. */
                  const delta = toNumber(h.delta) ?? 0;
                  const color = delta > 0 ? DARK.success : delta < 0 ? DARK.danger : DARK.textMuted;
                  return (
                  <div key={h.id} className="p-2 hover:bg-white/[0.02] border-b border-white/[0.04] flex items-center gap-2" data-testid={`rep-history-${h.id}`}>
                    {delta > 0 ? <ArrowUp size={12} style={{ color }} /> : delta < 0 ? <ArrowDown size={12} style={{ color }} /> : <Minus size={12} style={{ color }} />}
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs text-foreground truncate">{text(h.agent_name, "unnamed")}</p>
                      <p className="font-mono text-[10px] text-avaira-dim truncate">{text(h.reason, "")}</p>
                    </div>
                    <span className="font-mono text-xs font-bold" style={{ color }}>
                      {delta > 0 ? '+' : ''}{delta}
                    </span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
