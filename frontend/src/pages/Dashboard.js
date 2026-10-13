import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Activity, Users, Zap, ShieldOff, Wallet, TrendingUp, Play, AlertTriangle } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { toast } from "sonner";

import { API } from "@/lib/api";
import AgentDashboard from "@/components/AgentDashboard";
import TrustHeatmap from "@/components/TrustHeatmap";

import { CHART_COLORS, DARK, STATUS_COLORS as PLOT_STATUS_COLORS } from "@/lib/palette";
import { useCountUp } from "@/lib/motion";

// The figure counts up when the tile enters the viewport. The markup already
// carries the final value, so a static render, a crawler or a reduced-motion
// visitor reads the real number instead of a zero.
const StatCard = ({ icon: Icon, label, value, color, delay }) => {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value);
  const hasNumber = Number.isFinite(numeric);
  const decimals = typeof value === "string" && value.includes(".") ? value.split(".")[1].length : 0;
  const [figureRef, figure] = useCountUp(hasNumber ? numeric : 0, { decimals });

  return (
    <div
      className={`cyber-card p-4 animate-slide-in stagger-${delay} depth-mini-panel hover:glow-red transition-all`}
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex items-center gap-3">
        <div className="p-2 border" style={{ borderColor: `${color}40`, background: `${color}10` }}>
          <Icon size={16} strokeWidth={1.5} style={{ color }} />
        </div>
        <div>
          <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">{label}</p>
          <p className="font-heading font-bold text-xl text-foreground mt-0.5" ref={figureRef}>
            {hasNumber ? figure : value}
          </p>
        </div>
      </div>
    </div>
  );
};

const COLORS = CHART_COLORS;
const STATUS_COLORS = PLOT_STATUS_COLORS;

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-avaira-card border border-avaira-border p-2 font-mono text-xs">
        <p className="text-avaira-muted">{label}</p>
        {payload.map((p, i) => <p key={i} style={{ color: p.color }}>{p.name}: {typeof p.value === 'number' ? p.value.toFixed(4) : p.value}</p>)}
      </div>
    );
  }
  return null;
};

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [simulating, setSimulating] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, activityRes] = await Promise.all([
        axios.get(`${API}/dashboard/stats`),
        axios.get(`${API}/dashboard/activity`)
      ]);
      setStats(statsRes.data);
      setActivity(activityRes.data);
    } catch (e) {
      console.error("Dashboard fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const pollId = setInterval(() => {
      fetchData();
    }, 15000);
    return () => clearInterval(pollId);
  }, [fetchData]);

  const runSimulation = async () => {
    setSimulating(true);
    try {
      const res = await axios.post(`${API}/simulate/lifecycle`, {}, { withCredentials: true });
      toast.success(`Simulation complete: ${res.data.steps.length} steps executed`);
      fetchData();
    } catch (e) {
      toast.error("Simulation failed. Check admin privileges.");
    }
    setSimulating(false);
  };

  if (loading && !stats) {
    return (
      <div className="cyber-card p-6" data-testid="dashboard-loading">
        <p className="font-mono text-xs text-avaira-muted uppercase tracking-wider">Loading dashboard data...</p>
      </div>
    );
  }

  const pieData = stats ? [
    { name: 'Active', value: stats.active_agents || 0 },
    { name: 'Frozen', value: stats.frozen_agents || 0 },
    { name: 'Completed', value: stats.completed_executions || 0 },
    { name: 'Failed', value: stats.failed_executions || 0 },
  ].filter(d => d.value > 0) : [];

  const treasuryData = stats ? [
    { name: 'TrustPool', value: stats.trust_pool_balance || 0 },
    { name: 'Revenue', value: stats.protocol_revenue || 0 },
  ].filter(d => d.value > 0) : [];

  return (
    <div className="page-shell" data-testid="dashboard-page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Protocol Overview
          </h1>
          <p className="page-subtitle">Real-time execution monitoring</p>
        </div>
        <button
          data-testid="simulate-lifecycle-btn"
          onClick={runSimulation}
          disabled={simulating}
          className="cyber-btn bg-avaira-primary text-white px-4 py-2 font-heading text-sm flex items-center gap-2 disabled:opacity-50"
        >
          <Play size={14} />
          {simulating ? "SIMULATING..." : "SIMULATE LIFECYCLE"}
        </button>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Users} label="Total Agents" value={stats.total_agents} color={DARK.info} delay={1} />
          <StatCard icon={Activity} label="Active Agents" value={stats.active_agents} color={DARK.success} delay={2} />
          <StatCard icon={Zap} label="Executions" value={stats.total_executions} color={DARK.violet} delay={3} />
          <StatCard icon={ShieldOff} label="Frozen" value={stats.frozen_agents} color={DARK.danger} delay={4} />
          <StatCard icon={Wallet} label="Total Fees (USD)" value={stats.total_fees_collected.toFixed(2)} color={DARK.warning} delay={5} />
          <StatCard icon={TrendingUp} label="Trust Pool (USD)" value={stats.trust_pool_balance.toFixed(2)} color={DARK.info} delay={6} />
        </div>
      )}

      {/* Charts + Activity Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Activity Feed */}
        <div className="lg:col-span-2 cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-4 flex items-center gap-2">
            <Activity size={14} className="text-avaira-primary" /> Recent activity
          </h2>
          {activity.length === 0 ? (
            <div className="text-center py-8">
              <p className="font-mono text-xs text-avaira-dim">NO ACTIVITY YET</p>
              <p className="font-mono text-[10px] text-avaira-dim mt-1">Run a simulation to generate data</p>
            </div>
          ) : (
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {activity.map((item, i) => (
                <div key={item.id + i} className={`flex items-center gap-3 p-2 hover:bg-white/[0.02] transition-colors animate-slide-in stagger-${(i % 5) + 1}`} data-testid={`activity-item-${i}`}>
                  <div className={`status-dot ${item.status === 'completed' ? 'active' : item.status === 'freeze' || item.status === 'rejected_deviation' ? 'frozen' : 'paused'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs text-foreground truncate">{item.description}</p>
                    <p className="font-mono text-[10px] text-avaira-dim">{new Date(item.timestamp).toLocaleString()}</p>
                  </div>
                  <span className="font-mono text-[10px] px-2 py-0.5 border" style={{ borderColor: (STATUS_COLORS[item.status] || DARK.hairlineStrong) + '50', color: STATUS_COLORS[item.status] || DARK.textMuted }}>
                    {item.type.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Charts */}
        <div className="space-y-4">
          {/* Agent Distribution */}
          <div className="cyber-card p-4">
            <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3 flex items-center gap-2">
              <Users size={14} className="text-avaira-primary" /> Distribution
            </h2>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={2} dataKey="value" stroke="none">
                    {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-40 flex items-center justify-center">
                <p className="font-mono text-xs text-avaira-dim">NO DATA</p>
              </div>
            )}
            <div className="flex flex-wrap gap-3 mt-2">
              {pieData.map((d, i) => (
                <div key={d.name} className="flex items-center gap-1.5">
                  <div className="w-2 h-2" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="font-mono text-[10px] text-avaira-muted">{d.name}: {d.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Treasury Split */}
          <div className="cyber-card p-4">
            <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3 flex items-center gap-2">
              <Wallet size={14} className="text-avaira-primary" /> Treasury Split
            </h2>
            {treasuryData.length > 0 ? (
              <div className="space-y-2">
                {treasuryData.map((d, i) => (
                  <div key={d.name}>
                    <div className="flex justify-between font-mono text-xs mb-1">
                      <span className="text-avaira-muted">{d.name}</span>
                      <span className="text-foreground">${d.value.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-avaira-surface">
                      <div className="h-full transition-all duration-500" style={{
                        width: `${((d.value / (stats?.total_fees_collected || 1)) * 100)}%`,
                        background: i === 0 ? DARK.info : DARK.violet
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-20 flex items-center justify-center">
                <p className="font-mono text-xs text-avaira-dim">NO FEES COLLECTED</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <TrustHeatmap />
      <AgentDashboard />
    </div>
  );
}
