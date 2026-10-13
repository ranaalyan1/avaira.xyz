import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { ShieldOff, Snowflake, Scissors, AlertTriangle, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAuth } from "@/App";

import { API } from "@/lib/api";

export default function FreezeSlash() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const [events, setEvents] = useState([]);
  const [agents, setAgents] = useState([]);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [freezeForm, setFreezeForm] = useState({ agent_id: "", reason: "" });
  const [slashForm, setSlashForm] = useState({ agent_id: "", reason: "", amount: "" });

  const fetchData = useCallback(async () => {
    try {
      const [evRes, agRes] = await Promise.all([
        axios.get(`${API}/freeze/events`),
        axios.get(`${API}/agents`)
      ]);
      setEvents(evRes.data);
      setAgents(agRes.data);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const frozenAgents = agents.filter(a => a.status === "frozen");
  const activeAgents = agents.filter(a => a.status !== "frozen");

  const handleFreeze = async (e) => {
    e.preventDefault();
    if (!isAdmin) return toast.error("Admin only action");
    if (!freezeForm.agent_id) return toast.error("Select an agent");
    if (!freezeForm.reason.trim()) return toast.error("Reason is required");
    if (!window.confirm("Freeze this agent now? This blocks future executions until manually changed.")) return;
    try {
      await axios.post(`${API}/freeze/${freezeForm.agent_id}`, { reason: freezeForm.reason });
      toast.success("Agent frozen");
      setFreezeOpen(false);
      setFreezeForm({ agent_id: "", reason: "" });
      fetchData();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Freeze failed");
    }
  };

  const handleSlash = async (e) => {
    e.preventDefault();
    if (!isAdmin) return toast.error("Admin only action");
    if (!slashForm.agent_id) return toast.error("Select an agent");
    if (!slashForm.reason.trim()) return toast.error("Reason is required");
    if (slashForm.amount && parseFloat(slashForm.amount) <= 0) return toast.error("Slash amount must be greater than 0");
    if (!window.confirm("Slash collateral now? This action is irreversible.")) return;
    try {
      await axios.post(`${API}/slash/${slashForm.agent_id}`, {
        reason: slashForm.reason,
        amount: slashForm.amount ? parseFloat(slashForm.amount) : null
      });
      toast.success("Collateral slashed");
      setSlashOpen(false);
      setSlashForm({ agent_id: "", reason: "", amount: "" });
      fetchData();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Slash failed");
    }
  };

  return (
    <div className="page-shell animate-slide-in" data-testid="freeze-slash-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Freeze & Slash</h1>
          <p className="page-subtitle">{frozenAgents.length} frozen · {events.length} events</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="refresh-freeze-btn" onClick={fetchData} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
            <RefreshCw size={14} />
          </button>
          {!isAdmin && <span className="font-mono text-[10px] text-avaira-dim uppercase tracking-wider">Admin Only Controls</span>}
          {/* Freeze Dialog */}
          <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
            <DialogTrigger asChild>
              <button data-testid="freeze-agent-btn" disabled={!isAdmin} className="cyber-btn bg-avaira-red text-white px-4 py-2 font-heading text-sm flex items-center gap-2 disabled:opacity-40">
                <Snowflake size={14} /> FREEZE AGENT
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">Freeze Agent</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleFreeze} className="space-y-3 mt-2" data-testid="freeze-agent-form">
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Agent</label>
                  <select
                    data-testid="freeze-agent-select"
                    value={freezeForm.agent_id}
                    onChange={(e) => setFreezeForm(p => ({ ...p, agent_id: e.target.value }))}
                    className="w-full bg-black border border-white/20 focus:border-avaira-red text-white font-mono text-sm p-2 outline-none"
                  >
                    <option value="">Select agent...</option>
                    {activeAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Reason</label>
                  <textarea
                    data-testid="freeze-reason-input"
                    value={freezeForm.reason}
                    onChange={(e) => setFreezeForm(p => ({ ...p, reason: e.target.value }))}
                    placeholder="Deviation from declared mission..."
                    required
                    className="w-full bg-black border border-white/20 focus:border-avaira-red text-white font-mono text-sm p-2 outline-none h-20 resize-none"
                  />
                </div>
                <button data-testid="submit-freeze-btn" type="submit" className="w-full cyber-btn bg-avaira-red text-white py-2 font-heading text-sm">FREEZE AGENT</button>
              </form>
            </DialogContent>
          </Dialog>
          {/* Slash Dialog */}
          <Dialog open={slashOpen} onOpenChange={setSlashOpen}>
            <DialogTrigger asChild>
              <button data-testid="slash-agent-btn" disabled={!isAdmin} className="cyber-btn border border-avaira-yellow text-avaira-yellow px-4 py-2 font-heading text-sm flex items-center gap-2 disabled:opacity-40">
                <Scissors size={14} /> SLASH
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">Slash Collateral</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSlash} className="space-y-3 mt-2" data-testid="slash-agent-form">
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Agent</label>
                  <select
                    data-testid="slash-agent-select"
                    value={slashForm.agent_id}
                    onChange={(e) => setSlashForm(p => ({ ...p, agent_id: e.target.value }))}
                    className="w-full bg-black border border-white/20 focus:border-avaira-yellow text-white font-mono text-sm p-2 outline-none"
                  >
                    <option value="">Select agent...</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name} (${a.collateral_remaining.toFixed(2)})</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Reason</label>
                  <textarea
                    data-testid="slash-reason-input"
                    value={slashForm.reason}
                    onChange={(e) => setSlashForm(p => ({ ...p, reason: e.target.value }))}
                    placeholder="Critical deviation..."
                    required
                    className="w-full bg-black border border-white/20 focus:border-avaira-yellow text-white font-mono text-sm p-2 outline-none h-20 resize-none"
                  />
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Amount (optional, default 50%)</label>
                  <input
                    data-testid="slash-amount-input"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={slashForm.amount}
                    onChange={(e) => setSlashForm(p => ({ ...p, amount: e.target.value }))}
                    placeholder="Auto: 50% of remaining collateral"
                    className="w-full bg-black border border-white/20 focus:border-avaira-yellow text-white font-mono text-sm p-2 outline-none"
                  />
                </div>
                <button data-testid="submit-slash-btn" type="submit" className="w-full cyber-btn bg-avaira-yellow text-black py-2 font-heading text-sm">SLASH COLLATERAL</button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Frozen Agents */}
        <div className="cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-red mb-3 flex items-center gap-2">
            <ShieldOff size={14} /> Frozen Agents ({frozenAgents.length})
          </h2>
          {frozenAgents.length === 0 ? (
            <p className="font-mono text-xs text-avaira-dim text-center py-6">NO FROZEN AGENTS</p>
          ) : (
            <div className="space-y-2">
              {frozenAgents.map(a => (
                <div key={a.id} className="p-3 bg-red-500/5 border border-red-500/20" data-testid={`frozen-agent-${a.id}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold tracking-tight text-foreground">{a.name}</span>
                    <span className="status-dot frozen" />
                  </div>
                  <div className="font-mono text-[10px] text-avaira-muted mt-1 space-y-0.5">
                    <p>REP: <span className="text-avaira-red">{a.reputation.toFixed(0)}</span></p>
                    <p>COLLATERAL: <span className="text-foreground">${a.collateral_remaining.toFixed(2)}</span></p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Event Log */}
        <div className="lg:col-span-2 cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-avaira-yellow" /> Event Log
          </h2>
          {events.length === 0 ? (
            <p className="font-mono text-xs text-avaira-dim text-center py-8">NO EVENTS</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Agent</th>
                    <th>Reason</th>
                    <th className="text-right">Slashed</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(ev => (
                    <tr key={ev.id} data-testid={`event-row-${ev.id}`}>
                      <td>
                        <span className={`font-mono text-[10px] px-1.5 py-0.5 border uppercase ${
                          ev.type === 'freeze' ? 'border-red-500/30 text-red-400' : 'border-yellow-500/30 text-yellow-400'
                        }`}>{ev.type}</span>
                      </td>
                      <td className="text-foreground">{ev.agent_name}</td>
                      <td className="text-avaira-muted max-w-[200px] truncate">{ev.reason}</td>
                      <td className="text-right text-avaira-yellow">{ev.collateral_slashed > 0 ? `${ev.collateral_slashed.toFixed(4)}` : '-'}</td>
                      <td className="text-avaira-dim">{new Date(ev.timestamp).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
