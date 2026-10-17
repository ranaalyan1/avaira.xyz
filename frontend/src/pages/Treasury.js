import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Wallet, TrendingUp, ArrowUpRight, RefreshCw, Zap, Shield, Scissors, Database } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

import { API } from "@/lib/api";

import { DARK } from "@/lib/palette";
import { useSeo } from "@/lib/seo";
import { PageSkeleton } from "@/components/ui/page-states";

const STREAM_ICONS = { zap: Zap, shield: Shield, scissors: Scissors, database: Database };
const STREAM_COLORS = [DARK.info, DARK.violet, DARK.warning, DARK.success];

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-avaira-card border border-avaira-border p-2 font-mono text-xs">
        {payload.map((p, i) => <p key={i} style={{ color: p.color || p.fill }}>{p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value} USD</p>)}
      </div>
    );
  }
  return null;
};

export default function Treasury() {
  useSeo({
    title: "Treasury",
    description: "Trust pool balance, protocol revenue and fee flows.",
    path: "/treasury",
    noindex: true,
  });

  const [stats, setStats] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [revenueStreams, setRevenueStreams] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, txRes, revRes] = await Promise.all([
        axios.get(`${API}/treasury/stats`),
        axios.get(`${API}/treasury/transactions`),
        axios.get(`${API}/revenue/streams`)
      ]);
      setStats(statsRes.data);
      setTransactions(txRes.data);
      setRevenueStreams(revRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const splitData = stats ? [
    { name: 'TrustPool (75%)', value: stats.total_trust_pool },
    { name: 'Revenue (25%)', value: stats.total_protocol_revenue }
  ].filter(d => d.value > 0) : [];

  const barData = transactions.slice(0, 20).reverse().map((tx, i) => ({
    name: `TX${i + 1}`,
    trust: tx.trust_pool_share,
    revenue: tx.protocol_revenue_share,
    total: tx.total_fee
  }));

  return (
    <div className="page-shell animate-slide-in" data-testid="treasury-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Treasury</h1>
          <p className="page-subtitle">Fee collection and distribution</p>
        </div>
        <button data-testid="refresh-treasury-btn" onClick={fetchData} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
          <RefreshCw size={14} />
        </button>
      </div>

      {loading && !stats ? (
        <div className="mb-6" data-testid="treasury-skeleton">
          <PageSkeleton />
        </div>
      ) : null}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="cyber-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <Wallet size={14} className="text-avaira-primary" strokeWidth={1.5} />
              <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Total Fees</span>
            </div>
            <p className="font-heading font-bold text-xl text-avaira-primary" data-testid="total-fees-value">{stats.total_fees.toFixed(6)}</p>
            <p className="font-mono text-[10px] text-avaira-dim">USD</p>
          </div>
          <div className="cyber-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={14} className="text-avaira-primary" strokeWidth={1.5} />
              <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Trust Pool</span>
            </div>
            <p className="font-heading font-bold text-xl text-avaira-green" data-testid="trust-pool-value">{stats.total_trust_pool.toFixed(6)}</p>
            <p className="font-mono text-[10px] text-avaira-dim">75% of fees</p>
          </div>
          <div className="cyber-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpRight size={14} className="text-avaira-purple" strokeWidth={1.5} />
              <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Protocol Revenue</span>
            </div>
            <p className="font-heading font-bold text-xl text-avaira-purple" data-testid="revenue-value">{stats.total_protocol_revenue.toFixed(6)}</p>
            <p className="font-mono text-[10px] text-avaira-dim">25% of fees</p>
          </div>
          <div className="cyber-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <Wallet size={14} className="text-avaira-yellow" strokeWidth={1.5} />
              <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Transactions</span>
            </div>
            <p className="font-heading font-bold text-xl text-foreground" data-testid="tx-count-value">{stats.transaction_count}</p>
            <p className="font-mono text-[10px] text-avaira-dim">fee events</p>
          </div>
        </div>
      )}

      {/* 4 Revenue Streams */}
      {revenueStreams && (
        <div className="mb-6">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Revenue Streams</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {revenueStreams.streams.map((stream, i) => {
              const Icon = STREAM_ICONS[stream.icon] || Zap;
              return (
                <div key={stream.name} className="cyber-card p-4" data-testid={`stream-${i}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={14} style={{ color: STREAM_COLORS[i] }} strokeWidth={1.5} />
                    <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">{stream.name}</span>
                  </div>
                  <p className="font-heading font-bold text-lg" style={{ color: STREAM_COLORS[i] }}>${stream.amount.toFixed(2)}</p>
                  <p className="font-mono text-[10px] text-avaira-dim mt-1">{stream.description}</p>
                  <p className="font-mono text-[10px] text-avaira-dim mt-0.5">{stream.transactions} events</p>
                </div>
              );
            })}
          </div>
          <div className="mt-3 p-3 border border-avaira-primary/20 bg-avaira-primary/5">
            <span className="font-mono text-xs text-avaira-muted">TOTAL PROTOCOL REVENUE: </span>
            <span className="font-heading font-bold text-lg text-avaira-primary">${revenueStreams.total_revenue.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Fee Split Pie */}
        <div className="cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Fee Split</h2>
          {splitData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={splitData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value" stroke="none">
                    <Cell fill={DARK.info} />
                    <Cell fill={DARK.violet} />
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-6 mt-2">
                {splitData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-1.5">
                    <div className="w-2 h-2" style={{ background: i === 0 ? DARK.info : DARK.violet }} />
                    <span className="font-mono text-[10px] text-avaira-muted">{d.name}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 flex items-center justify-center">
              <p className="font-mono text-xs text-avaira-dim">NO FEE DATA</p>
            </div>
          )}
        </div>

        {/* Fee Bar Chart */}
        <div className="cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Fee History</h2>
          {barData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={barData}>
                <CartesianGrid strokeDasharray="3 3" stroke={DARK.hairline} />
                <XAxis dataKey="name" tick={{ fill: DARK.textMuted, fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                <YAxis tick={{ fill: DARK.textMuted, fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="trust" name="TrustPool" fill={DARK.info} stackId="a" />
                <Bar dataKey="revenue" name="Revenue" fill={DARK.violet} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center">
              <p className="font-mono text-xs text-avaira-dim">NO DATA</p>
            </div>
          )}
        </div>

        {/* Transaction List */}
        <div className="cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Recent Transactions</h2>
          {transactions.length === 0 ? (
            <p className="font-mono text-xs text-avaira-dim text-center py-8">NO TRANSACTIONS</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {transactions.slice(0, 15).map(tx => (
                <div key={tx.id} className="p-2 hover:bg-white/[0.02] border-b border-white/[0.04]" data-testid={`treasury-tx-${tx.id}`}>
                  <div className="flex justify-between font-mono text-xs">
                    <span className="text-foreground">${tx.total_fee.toFixed(2)}</span>
                    <span className="text-avaira-dim">{new Date(tx.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="flex gap-4 mt-0.5 font-mono text-[10px]">
                    <span className="text-avaira-primary">TP: {tx.trust_pool_share.toFixed(6)}</span>
                    <span className="text-avaira-purple">REV: {tx.protocol_revenue_share.toFixed(6)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
