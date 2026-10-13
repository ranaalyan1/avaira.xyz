import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { Brain, PlayCircle, ShieldAlert, Trophy, Radar, Sparkles } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

import { API } from "@/lib/api";

import { DARK } from "@/lib/palette";

function useAgentLeaderboard() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    const fetchLeaderboard = async () => {
      try {
        const res = await axios.get(`${API}/agent/leaderboard`);
        if (mounted) {
          setLeaderboard(res.data || []);
          setError("");
        }
      } catch (err) {
        if (mounted) {
          setError(err?.response?.data?.detail || "Unable to load AI agent leaderboard");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchLeaderboard();
    const intervalId = setInterval(fetchLeaderboard, 10000);
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  return { leaderboard, loading, error };
}

function StatusBadge({ status }) {
  const normalized = (status || "pending").toLowerCase();
  const styles = {
    active: "border-avaira-green/40 text-avaira-green bg-avaira-green/10",
    frozen: "border-avaira-red/40 text-avaira-red bg-avaira-red/10",
    pending: "border-amber-400/40 text-amber-300 bg-amber-400/10",
    approved: "border-avaira-green/40 text-avaira-green bg-avaira-green/10",
    rejected: "border-avaira-red/40 text-avaira-red bg-avaira-red/10",
  };
  return <span className={`font-mono text-[10px] uppercase tracking-[0.22em] px-2 py-1 border ${styles[normalized] || styles.pending}`}>{normalized}</span>;
}

function ConfidenceBar({ value }) {
  return (
    <div className="w-full h-2 bg-avaira-surface border border-avaira-border overflow-hidden">
      <div className="h-full bg-gradient-to-r from-avaira-primary via-cyan-300 to-avaira-green transition-all duration-500" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export default function AgentDashboard() {
  const { leaderboard, loading, error } = useAgentLeaderboard();
  const [form, setForm] = useState({
    agent_id: "agent_123",
    mission_goal: "Help users find the best travel deals within their budget and preferences.",
    risk_envelope: {
      max_spend_usd: 100.0,
      allowed_actions: ["search", "summarize", "email"],
    },
    market_context: {
      target: "travel_apis",
      suggested_value_usd: 42.0,
      market_signal: "high season",
    },
    history: [],
  });
  const [thinkLoading, setThinkLoading] = useState(false);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [intentResult, setIntentResult] = useState(null);
  const [lifecycleResult, setLifecycleResult] = useState(null);
  const [historySeries, setHistorySeries] = useState([]);
  const thinkingFrames = useMemo(() => ["Scanning market context", "Comparing mission goal", "Validating risk envelope", "Preparing execution intent"], []);
  const [frameIndex, setFrameIndex] = useState(0);
  const frameTimer = useRef(null);

  useEffect(() => {
    if (thinkLoading || lifecycleLoading) {
      frameTimer.current = setInterval(() => {
        setFrameIndex((value) => (value + 1) % thinkingFrames.length);
      }, 800);
      return () => clearInterval(frameTimer.current);
    }
    setFrameIndex(0);
    return undefined;
  }, [thinkLoading, lifecycleLoading, thinkingFrames.length]);

  const pushHistoryPoint = (label, score) => {
    setHistorySeries((current) => [...current.slice(-9), { label, score }]);
  };

  const runThink = async () => {
    setThinkLoading(true);
    try {
      const res = await axios.post(`${API}/agent/think`, form);
      setIntentResult(res.data);
      if (res.data?.avaira_score?.score !== undefined) {
        pushHistoryPoint(`Think ${historySeries.length + 1}`, res.data.avaira_score.score);
      }
    } catch (err) {
      setIntentResult({
        status: "rejected",
        reason: err?.response?.data?.detail || "Agent runtime request failed",
      });
    } finally {
      setThinkLoading(false);
    }
  };

  const runLifecycle = async () => {
    setLifecycleLoading(true);
    try {
      const res = await axios.post(`${API}/agent/simulate-full-lifecycle`, form);
      setLifecycleResult(res.data);
      if (res.data?.intent) {
        setIntentResult({
          status: res.data.status,
          intent: res.data.intent,
          reason: res.data.lifecycle?.find((step) => step.name === "validate")?.details?.reason || "Lifecycle complete",
          avaira_score: res.data.avaira_score,
        });
      }
      if (res.data?.avaira_score?.score !== undefined) {
        pushHistoryPoint(`Cycle ${historySeries.length + 1}`, res.data.avaira_score.score);
      }
    } catch (err) {
      setLifecycleResult({
        status: "rejected",
        lifecycle: [],
        error: err?.response?.data?.detail || "Lifecycle simulation failed",
      });
    } finally {
      setLifecycleLoading(false);
    }
  };

  return (
    <section className="mt-8 grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6" data-testid="agent-dashboard-section">
      <div className="space-y-6">
        <div className="cyber-card p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-heading text-xl uppercase tracking-tight text-foreground flex items-center gap-2">
                <Brain size={18} className="text-avaira-primary" /> AI Agent Runtime
              </h2>
              <p className="font-mono text-[11px] text-avaira-muted mt-1">Run local policy-aware planning against live AVAIRA risk constraints.</p>
            </div>
            <StatusBadge status={intentResult?.status || "pending"} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">
              Agent ID
              <input className="mt-1 w-full bg-avaira-surface border border-avaira-border px-3 py-2 text-xs text-foreground" value={form.agent_id} onChange={(e) => setForm((current) => ({ ...current, agent_id: e.target.value }))} />
            </label>
            <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">
              Mission Goal
              <input className="mt-1 w-full bg-avaira-surface border border-avaira-border px-3 py-2 text-xs text-foreground" value={form.mission_goal} onChange={(e) => setForm((current) => ({ ...current, mission_goal: e.target.value }))} />
            </label>
            <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">
              Max Spend (USD)
              <input type="number" step="1" className="mt-1 w-full bg-avaira-surface border border-avaira-border px-3 py-2 text-xs text-foreground" value={form.risk_envelope.max_spend_usd} onChange={(e) => setForm((current) => ({ ...current, risk_envelope: { ...current.risk_envelope, max_spend_usd: Number(e.target.value) } }))} />
            </label>
            <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">
              Allowed Actions
              <input className="mt-1 w-full bg-avaira-surface border border-avaira-border px-3 py-2 text-xs text-foreground" value={form.risk_envelope.allowed_actions.join(",")} onChange={(e) => setForm((current) => ({ ...current, risk_envelope: { ...current.risk_envelope, allowed_actions: e.target.value.split(",").map((item) => item.trim()).filter(Boolean) } }))} />
            </label>
          </div>

          <div className="flex flex-wrap gap-3">
            <button className="cyber-btn bg-avaira-primary text-white px-4 py-2 font-heading text-sm flex items-center gap-2 disabled:opacity-50" onClick={runThink} disabled={thinkLoading || lifecycleLoading}>
              <Sparkles size={14} /> {thinkLoading ? thinkingFrames[frameIndex] : "Run Agent"}
            </button>
            <button className="cyber-btn px-4 py-2 font-heading text-sm flex items-center gap-2 border border-avaira-border text-foreground disabled:opacity-50" onClick={runLifecycle} disabled={lifecycleLoading || thinkLoading}>
              <PlayCircle size={14} /> {lifecycleLoading ? thinkingFrames[frameIndex] : "Simulate Full Lifecycle"}
            </button>
          </div>
        </div>

        <div className="cyber-card p-5 hologram-effect">
          <div className="flex items-center gap-2 mb-4">
            <Radar size={16} className="text-avaira-primary animate-pulse" />
            <h3 className="font-heading text-sm uppercase tracking-[0.18em] text-avaira-muted">Intent Output</h3>
          </div>
          {intentResult?.intent ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="border border-avaira-border p-3 bg-avaira-surface/60">
                  <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">Action</p>
                  <p className="font-heading text-lg text-foreground mt-1">{intentResult.intent.action}</p>
                </div>
                <div className="border border-avaira-border p-3 bg-avaira-surface/60">
                  <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">Target</p>
                  <p className="font-mono text-xs text-foreground mt-1 break-all">{intentResult.intent.target}</p>
                </div>
                <div className="border border-avaira-border p-3 bg-avaira-surface/60">
                  <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">Estimated Value</p>
                  <p className="font-heading text-lg text-foreground mt-1">${intentResult.intent.estimated_value} USD</p>
                </div>
              </div>
              <div>
                <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em] mb-2">Rationale</p>
                <p className="text-sm text-foreground leading-6">{intentResult.intent.rationale}</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-[0.22em]">Confidence</p>
                  <span className="font-mono text-xs text-foreground">{Math.round((intentResult.intent.confidence || 0) * 100)}%</span>
                </div>
                <ConfidenceBar value={intentResult.intent.confidence || 0} />
              </div>
              <div className={`border px-3 py-2 text-sm ${intentResult.status === "approved" ? "border-avaira-green/40 bg-avaira-green/10 text-avaira-green" : "border-avaira-red/40 bg-avaira-red/10 text-avaira-red"}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-heading uppercase tracking-[0.18em]">{intentResult.status === "approved" ? "Approved" : "Rejected"}</span>
                  {intentResult.avaira_score?.score !== undefined && <span className="font-mono text-xs">Score {intentResult.avaira_score.score} · {intentResult.avaira_score.grade}</span>}
                </div>
                <p className="mt-2 font-mono text-xs">{intentResult.reason}</p>
              </div>
            </div>
          ) : (
            <p className="font-mono text-xs text-avaira-dim">No AI intent yet. Run the agent to generate a policy-constrained execution proposal.</p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        <div className="cyber-card p-5 depth-mini-panel">
          <div className="flex items-center gap-2 mb-4">
            <Trophy size={16} className="text-avaira-primary" />
            <h3 className="font-heading text-sm uppercase tracking-[0.18em] text-avaira-muted">Live Agent Leaderboard</h3>
          </div>
          {loading ? <p className="font-mono text-xs text-avaira-dim">Loading leaderboard...</p> : error ? <p className="font-mono text-xs text-avaira-red">{error}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-avaira-border font-mono text-[10px] uppercase tracking-[0.22em] text-avaira-muted">
                    <th className="py-2">Agent</th>
                    <th className="py-2">Score</th>
                    <th className="py-2">Collateral</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry) => (
                    <tr key={entry.agent_id || entry.wallet_address} className="border-b border-avaira-border/50 font-mono text-xs text-foreground">
                      <td className="py-3">
                        <div>
                          <p>{entry.name || "Unnamed Agent"}</p>
                          <p className="text-avaira-dim text-[10px] mt-1">{entry.wallet_address?.slice(0, 10)}...</p>
                        </div>
                      </td>
                      <td className="py-3">{entry.avaira_score} · {entry.grade}</td>
                      <td className="py-3">{entry.collateral}</td>
                      <td className="py-3"><StatusBadge status={entry.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="cyber-card p-5 data-stream-container">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert size={16} className="text-avaira-primary" />
            <h3 className="font-heading text-sm uppercase tracking-[0.18em] text-avaira-muted">Lifecycle Timeline</h3>
          </div>
          {lifecycleResult?.lifecycle?.length ? (
            <div className="space-y-3">
              {lifecycleResult.lifecycle.map((step) => (
                <div key={`${step.stage}-${step.name}`} className="border border-avaira-border p-3 bg-avaira-surface/50 animate-slide-in hologram-effect">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-heading text-sm uppercase tracking-[0.18em] text-foreground">{step.stage}. {step.name.replace(/_/g, " ")}</p>
                    <StatusBadge status={step.status === "failed" ? "rejected" : step.status} />
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-avaira-dim">{JSON.stringify(step.details, null, 2)}</pre>
                </div>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-avaira-dim">Run the full lifecycle simulator to populate the 8-step timeline judges can inspect.</p>
          )}
        </div>

        <div className="cyber-card p-5">
          <h3 className="font-heading text-sm uppercase tracking-[0.18em] text-avaira-muted mb-4">Reputation Trend</h3>
          {historySeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={historySeries}>
                <CartesianGrid stroke={DARK.hairline} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: DARK.textMuted, fontSize: 10 }} stroke={DARK.hairline} />
                <YAxis tick={{ fill: DARK.textMuted, fontSize: 10 }} stroke={DARK.hairline} domain={[0, 100]} />
                <Tooltip contentStyle={{ background: DARK.card, border: `1px solid ${DARK.hairlineStrong}`, color: DARK.textPrimary }} />
                <Line type="monotone" dataKey="score" stroke={DARK.info} strokeWidth={2} dot={{ r: 3, fill: DARK.success }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="font-mono text-xs text-avaira-dim">Reputation history appears here after runs.</p>
          )}
        </div>
      </div>
    </section>
  );
}