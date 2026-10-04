import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Users, Wallet, TrendingUp, Shield, Plus, Zap, RefreshCw, CheckCircle, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAuth } from "@/App";

import { API } from "@/lib/api";
import DynamicCollateralCard from "@/components/DynamicCollateralCard";

const GRADE_COLORS = { AAA: '#39FF14', AA: '#00F0FF', A: '#00F0FF', BBB: '#FFD300', BB: '#FFD300', B: '#FF8C00', CCC: '#FF003C', D: '#FF003C' };

export default function Underwriters() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const [underwriters, setUnderwriters] = useState([]);
  const [missions, setMissions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [missionOpen, setMissionOpen] = useState(false);
  const [stakeOpen, setStakeOpen] = useState(false);
  const [selectedMission, setSelectedMission] = useState(null);
  const [uwForm, setUwForm] = useState({ name: "", capital_amount: "5.0" });
  const [missionForm, setMissionForm] = useState({ agent_id: "", description: "", target_value: "1.0", duration_hours: "24", risk_level: "medium" });
  const [stakeForm, setStakeForm] = useState({ underwriter_id: "", amount: "1.0" });

  const fetchData = useCallback(async () => {
    try {
      const [uwRes, mRes, aRes] = await Promise.all([
        axios.get(`${API}/underwriters`),
        axios.get(`${API}/missions`),
        axios.get(`${API}/agents`)
      ]);
      setUnderwriters(uwRes.data);
      setMissions(mRes.data);
      setAgents(aRes.data);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRegisterUW = async (e) => {
    e.preventDefault();
    if (!uwForm.name.trim()) return toast.error("Name is required");
    if (parseFloat(uwForm.capital_amount) <= 0) return toast.error("Capital must be greater than 0");
    try {
      await axios.post(`${API}/underwriters/register`, { name: uwForm.name, capital_amount: parseFloat(uwForm.capital_amount) });
      toast.success("Underwriter registered");
      setRegisterOpen(false);
      setUwForm({ name: "", capital_amount: "5.0" });
      fetchData();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const handleCreateMission = async (e) => {
    e.preventDefault();
    if (!missionForm.agent_id || !missionForm.description.trim()) return toast.error("Agent and description are required");
    if (parseFloat(missionForm.target_value) <= 0) return toast.error("Mission value must be greater than 0");
    if (parseInt(missionForm.duration_hours, 10) <= 0) return toast.error("Duration must be greater than 0 hours");
    try {
      await axios.post(`${API}/missions/create`, {
        agent_id: missionForm.agent_id,
        description: missionForm.description,
        target_value: parseFloat(missionForm.target_value),
        duration_hours: parseInt(missionForm.duration_hours),
        risk_level: missionForm.risk_level
      });
      toast.success("Mission created");
      setMissionOpen(false);
      setMissionForm({ agent_id: "", description: "", target_value: "1.0", duration_hours: "24", risk_level: "medium" });
      fetchData();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const handleStake = async (e) => {
    e.preventDefault();
    if (!selectedMission) return;
    if (!stakeForm.underwriter_id) return toast.error("Select an underwriter");
    if (parseFloat(stakeForm.amount) <= 0) return toast.error("Stake amount must be greater than 0");
    try {
      await axios.post(`${API}/missions/${selectedMission.id}/stake`, { underwriter_id: stakeForm.underwriter_id, amount: parseFloat(stakeForm.amount) });
      toast.success("Staked successfully");
      setStakeOpen(false);
      setStakeForm({ underwriter_id: "", amount: "1.0" });
      fetchData();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const handleSettle = async (missionId, success) => {
    if (!isAdmin) return toast.error("Admin only action");
    const label = success ? "settle as SUCCESS" : "mark as FAILED";
    if (!window.confirm(`This action is irreversible. Continue to ${label}?`)) return;
    try {
      const res = await axios.post(`${API}/missions/${missionId}/settle?success=${success}`);
      toast.success(`Mission ${res.data.result}: ${success ? `Agent: ${res.data.agent_payout} / UW: ${res.data.underwriter_payout}` : 'Coverage provided'}`);
      fetchData();
    } catch (e) { toast.error(e.response?.data?.detail || "Settlement failed"); }
  };

  const openMissions = missions.filter(m => m.status === "open");
  const settledMissions = missions.filter(m => m.status === "settled");
  const totalStaked = underwriters.reduce((s, u) => s + u.capital_staked, 0);
  const totalEarnings = underwriters.reduce((s, u) => s + u.total_earnings, 0);

  return (
    <div className="page-shell animate-slide-in" data-testid="underwriters-page">
      <div className="mb-6">
        <DynamicCollateralCard />
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title font-heading font-bold text-foreground uppercase tracking-tight">Underwriter Marketplace</h1>
          <p className="page-subtitle font-mono text-xs text-avaira-muted mt-1">{underwriters.length} UNDERWRITERS / {missions.length} MISSIONS</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="refresh-uw-btn" onClick={fetchData} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
            <RefreshCw size={14} />
          </button>
          <Dialog open={missionOpen} onOpenChange={setMissionOpen}>
            <DialogTrigger asChild>
              <button data-testid="create-mission-btn" className="cyber-btn border border-avaira-purple text-avaira-purple px-3 py-2 font-heading text-xs flex items-center gap-1.5">
                <Zap size={12} /> NEW MISSION
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader><DialogTitle className="font-heading font-bold text-lg text-foreground uppercase tracking-tight">Create Mission</DialogTitle><DialogDescription className="font-mono text-[10px] text-avaira-dim">Declare a new mission for an agent to execute</DialogDescription></DialogHeader>
              <form onSubmit={handleCreateMission} className="space-y-3 mt-2" data-testid="create-mission-form">
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Agent</label>
                  <select data-testid="mission-agent-select" value={missionForm.agent_id} onChange={e => setMissionForm(p => ({ ...p, agent_id: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none">
                    <option value="">Select agent...</option>
                    {agents.filter(a => a.status === 'active').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Description</label>
                  <input data-testid="mission-description" value={missionForm.description} onChange={e => setMissionForm(p => ({ ...p, description: e.target.value }))} placeholder="DeFi rebalance operation..." className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Value (USD)</label>
                    <input data-testid="mission-value" type="number" step="0.1" min="0.1" value={missionForm.target_value} onChange={e => setMissionForm(p => ({ ...p, target_value: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
                  </div>
                  <div>
                    <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Risk Level</label>
                    <select data-testid="mission-risk" value={missionForm.risk_level} onChange={e => setMissionForm(p => ({ ...p, risk_level: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none">
                      <option value="low">LOW</option>
                      <option value="medium">MEDIUM</option>
                      <option value="high">HIGH</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Duration (hours)</label>
                  <input data-testid="mission-duration" type="number" min="1" step="1" value={missionForm.duration_hours} onChange={e => setMissionForm(p => ({ ...p, duration_hours: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
                </div>
                <button data-testid="submit-mission-btn" type="submit" className="w-full cyber-btn bg-avaira-purple text-white py-2 font-heading text-sm">CREATE MISSION</button>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
            <DialogTrigger asChild>
              <button data-testid="register-uw-btn" className="cyber-btn bg-avaira-primary text-white px-3 py-2 font-heading text-xs flex items-center gap-1.5">
                <Plus size={12} /> REGISTER UNDERWRITER
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader><DialogTitle className="font-heading font-bold text-lg text-foreground uppercase tracking-tight">Register Underwriter</DialogTitle><DialogDescription className="font-mono text-[10px] text-avaira-dim">Stake capital to underwrite agent missions</DialogDescription></DialogHeader>
              <form onSubmit={handleRegisterUW} className="space-y-3 mt-2" data-testid="register-uw-form">
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Name</label>
                  <input data-testid="uw-name-input" value={uwForm.name} onChange={e => setUwForm(p => ({ ...p, name: e.target.value }))} placeholder="Underwriter Alpha" required className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Capital (USD)</label>
                  <input data-testid="uw-capital-input" type="number" step="0.1" min="0.5" value={uwForm.capital_amount} onChange={e => setUwForm(p => ({ ...p, capital_amount: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
                </div>
                <button data-testid="submit-uw-btn" type="submit" className="w-full cyber-btn bg-avaira-primary text-white py-2 font-heading text-sm">REGISTER & DEPOSIT</button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="cyber-card p-4">
          <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Underwriters</p>
          <p className="font-heading font-bold text-xl text-foreground">{underwriters.length}</p>
        </div>
        <div className="cyber-card p-4">
          <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Capital Staked</p>
          <p className="font-heading font-bold text-xl text-avaira-primary">${totalStaked.toFixed(2)}</p>
        </div>
        <div className="cyber-card p-4">
          <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Total Earnings</p>
          <p className="font-heading font-bold text-xl text-avaira-green">${totalEarnings.toFixed(2)}</p>
        </div>
        <div className="cyber-card p-4">
          <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Open Missions</p>
          <p className="font-heading font-bold text-xl text-avaira-yellow">{openMissions.length}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Mission Marketplace */}
        <div className="lg:col-span-2 space-y-4">
          <div className="cyber-card p-4">
            <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-primary mb-3 flex items-center gap-2">
              <Zap size={14} /> Open Missions
            </h2>
            {openMissions.length === 0 ? (
              <p className="font-mono text-xs text-avaira-dim text-center py-6">NO OPEN MISSIONS</p>
            ) : (
              <div className="space-y-2">
                {openMissions.map(m => (
                  <div key={m.id} className="p-3 border border-avaira-border hover:border-avaira-primary/30 transition-colors" data-testid={`mission-${m.id}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-heading font-bold text-sm text-foreground uppercase">{m.agent_name}</span>
                        <span className="font-mono text-[10px] ml-2 px-1.5 py-0.5 border" style={{ borderColor: (GRADE_COLORS[m.agent_grade] || '#858585') + '50', color: GRADE_COLORS[m.agent_grade] || '#858585' }}>{m.agent_grade}</span>
                      </div>
                      <span className={`font-mono text-[10px] px-1.5 py-0.5 border ${m.risk_level === 'high' ? 'border-red-500/30 text-red-400' : m.risk_level === 'medium' ? 'border-yellow-500/30 text-yellow-400' : 'border-green-500/30 text-green-400'}`}>{m.risk_level.toUpperCase()}</span>
                    </div>
                    <p className="font-mono text-xs text-avaira-muted">{m.description}</p>
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-avaira-border">
                      <div className="flex gap-4 font-mono text-[10px]">
                        <span className="text-avaira-primary">VALUE: ${m.target_value}</span>
                        <span className="text-avaira-green">STAKED: ${m.total_staked.toFixed(2)}</span>
                        <span className="text-avaira-muted">UW: {m.underwriters.length}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          data-testid={`stake-mission-${m.id}`}
                          onClick={() => { setSelectedMission(m); setStakeOpen(true); }}
                          className="font-mono text-[10px] px-2 py-1 border border-avaira-primary/50 text-avaira-primary hover:bg-avaira-primary/10 transition-colors"
                        >STAKE</button>
                        <button
                          data-testid={`settle-success-${m.id}`}
                          onClick={() => handleSettle(m.id, true)}
                          disabled={!isAdmin}
                          className="font-mono text-[10px] px-2 py-1 border border-green-500/50 text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40"
                        ><CheckCircle size={10} className="inline mr-0.5" />SETTLE</button>
                        <button
                          data-testid={`settle-fail-${m.id}`}
                          onClick={() => handleSettle(m.id, false)}
                          disabled={!isAdmin}
                          className="font-mono text-[10px] px-2 py-1 border border-red-500/50 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                        ><XCircle size={10} className="inline mr-0.5" />FAIL</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Settled Missions */}
          {settledMissions.length > 0 && (
            <div className="cyber-card p-4">
              <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-muted mb-3">Settled Missions</h2>
              <table className="w-full data-table">
                <thead>
                  <tr><th>Agent</th><th>Description</th><th className="text-right">Value</th><th>Result</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {settledMissions.slice(0, 10).map(m => (
                    <tr key={m.id}>
                      <td className="text-foreground">{m.agent_name}</td>
                      <td className="text-avaira-muted truncate max-w-[150px]">{m.description}</td>
                      <td className="text-right text-avaira-primary">{m.target_value}</td>
                      <td><span className={`font-mono text-[10px] px-1.5 py-0.5 border ${m.result === 'success' ? 'border-green-500/30 text-green-400' : 'border-red-500/30 text-red-400'}`}>{m.result?.toUpperCase()}</span></td>
                      <td className="text-avaira-dim">{m.settled_at ? new Date(m.settled_at).toLocaleTimeString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Underwriter List */}
        <div className="cyber-card p-4">
          <h2 className="font-heading font-semibold text-sm uppercase tracking-wider text-avaira-muted mb-3 flex items-center gap-2">
            <Users size={14} className="text-avaira-primary" /> Underwriters
          </h2>
          {underwriters.length === 0 ? (
            <p className="font-mono text-xs text-avaira-dim text-center py-6">NO UNDERWRITERS</p>
          ) : (
            <div className="space-y-2">
              {underwriters.map(uw => (
                <div key={uw.id} className="p-3 border border-avaira-border" data-testid={`uw-card-${uw.id}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-heading font-bold text-sm text-foreground uppercase">{uw.name}</span>
                    <span className="font-mono text-[10px] text-avaira-green">{uw.total_earnings.toFixed(4)} earned</span>
                  </div>
                  <div className="space-y-0.5 font-mono text-[10px]">
                    <div className="flex justify-between"><span className="text-avaira-muted">AVAILABLE</span><span className="text-avaira-primary">${uw.capital_available.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-avaira-muted">STAKED</span><span className="text-avaira-yellow">${uw.capital_staked.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-avaira-muted">MISSIONS</span><span className="text-foreground">{uw.missions_successful}/{uw.missions_underwritten}</span></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stake Dialog */}
      <Dialog open={stakeOpen} onOpenChange={setStakeOpen}>
        <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
          <DialogHeader><DialogTitle className="font-heading font-bold text-lg text-foreground uppercase tracking-tight">Stake on Mission</DialogTitle><DialogDescription className="font-mono text-[10px] text-avaira-dim">Back this mission with your capital</DialogDescription></DialogHeader>
          {selectedMission && (
            <form onSubmit={handleStake} className="space-y-3 mt-2" data-testid="stake-form">
              <p className="font-mono text-xs text-avaira-muted">{selectedMission.agent_name}: {selectedMission.description}</p>
              <div>
                <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Underwriter</label>
                <select data-testid="stake-uw-select" value={stakeForm.underwriter_id} onChange={e => setStakeForm(p => ({ ...p, underwriter_id: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none">
                  <option value="">Select underwriter...</option>
                  {underwriters.filter(u => u.capital_available > 0).map(u => <option key={u.id} value={u.id}>{u.name} ({u.capital_available.toFixed(2)} avail)</option>)}
                </select>
              </div>
              <div>
                <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Amount (USD)</label>
                <input data-testid="stake-amount-input" type="number" step="0.1" min="0.1" value={stakeForm.amount} onChange={e => setStakeForm(p => ({ ...p, amount: e.target.value }))} className="w-full bg-black border border-white/20 text-white font-mono text-sm p-2 outline-none" />
              </div>
              <button data-testid="submit-stake-btn" type="submit" className="w-full cyber-btn bg-avaira-primary text-white py-2 font-heading text-sm">STAKE CAPITAL</button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
