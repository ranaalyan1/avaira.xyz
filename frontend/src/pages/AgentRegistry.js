import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { UserPlus, Shield, Zap, AlertTriangle, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAuth } from "@/App";
import OperatorTools from "@/components/OperatorTools";

import { API } from "@/lib/api";

const GRADE_COLORS = { AAA: '#39FF14', AA: '#00F0FF', A: '#00F0FF', BBB: '#FFD300', BB: '#FFD300', B: '#FF8C00', CCC: '#FF003C', D: '#FF003C' };

const StatusBadge = ({ status }) => {
  const styles = {
    active: "border-green-500/50 text-green-400 bg-green-500/10",
    frozen: "border-red-500/50 text-red-400 bg-red-500/10",
    paused: "border-yellow-500/50 text-yellow-400 bg-yellow-500/10",
  };
  return (
    <span className={`font-mono uppercase text-[10px] tracking-wider border px-2 py-0.5 ${styles[status] || styles.paused}`} data-testid={`status-badge-${status}`}>
      {status}
    </span>
  );
};

const AgentCard = ({ agent, onRefresh, scores, canManage }) => {
  const score = scores.find(s => s.agent_id === agent.id);
  const isFrozen = agent.status === "frozen";

  const handleToggleStatus = async () => {
    const newStatus = agent.status === "active" ? "paused" : "active";
    if (agent.status === "frozen") return toast.error("Cannot change status of frozen agent");
    if (!canManage) {
      return toast.error("Admin only action");
    }
    try {
      await axios.patch(`${API}/agents/${agent.id}/status?status=${newStatus}`);
      toast.success(`Agent ${newStatus}`);
      onRefresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to update");
    }
  };

  return (
    <div className={`cyber-card corner-cut p-4 animate-floating ${isFrozen ? 'animate-glitch' : ''}`} data-testid={`agent-card-${agent.id}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="agent-avatar-container hologram-effect">
            <div className={`agent-avatar-hologram animate-hologram ${isFrozen ? 'bg-avaira-red' : 'bg-avaira-primary'}`} />
          </div>
          <div>
            <h3 className={`font-heading font-bold text-base text-foreground uppercase tracking-tight ${isFrozen ? 'glitch-text text-avaira-red' : ''}`}>{agent.name}</h3>
            <p className="font-mono text-[10px] text-avaira-dim">ID: {agent.id.slice(0, 8)}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {score && (
            <span className="font-heading font-bold text-sm px-2 py-0.5 border" style={{ borderColor: (GRADE_COLORS[score.grade] || '#858585') + '50', color: GRADE_COLORS[score.grade] || '#858585' }} data-testid={`grade-${agent.id}`}>
              {score.grade}
            </span>
          )}
          <StatusBadge status={agent.status} />
        </div>
      </div>
      <div className="space-y-2 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-avaira-muted">API KEY</span>
          <span className="text-foreground truncate ml-2 max-w-[140px]">********************</span>
        </div>
        <div className="flex justify-between">
          <span className="text-avaira-muted">REPUTATION</span>
          <span style={{ color: agent.reputation >= 80 ? '#39FF14' : agent.reputation >= 50 ? '#FFD300' : '#FF003C' }}>
            {agent.reputation.toFixed(0)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-avaira-muted">EXECUTIONS</span>
          <span className="text-foreground">{agent.successful_executions}/{agent.total_executions}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-avaira-muted">MISSION</span>
          <span className="text-foreground truncate ml-2 max-w-[180px]">{agent.goal}</span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-avaira-border flex items-center justify-between">
        <span className="font-mono text-[10px] text-avaira-dim">
          {new Date(agent.registered_at).toLocaleDateString()}
        </span>
        <div className="flex items-center gap-3">
          <button
            data-testid={`toggle-status-${agent.id}`}
            onClick={handleToggleStatus}
            disabled={agent.status === "frozen" || !canManage}
            className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors disabled:opacity-30"
          >
            {!canManage ? "ADMIN ONLY" : agent.status === "active" ? "PAUSE" : agent.status === "frozen" ? "FROZEN" : "ACTIVATE"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function AgentRegistry() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const [agents, setAgents] = useState([]);
  const [scores, setScores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [form, setForm] = useState({
    name: "", goal: "", webhook_url: "",
    max_spend_usd: "50.0", allowed_actions: "search,summarize,email",
    require_human_approval_above_usd: "100.0"
  });

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const [aRes, sRes] = await Promise.all([
        axios.get(`${API}/agents`),
        axios.get(`${API}/scores/all`)
      ]);
      setAgents(aRes.data);
      setScores(sRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.goal.trim()) {
      return toast.error("Name and goal are required");
    }
    try {
      const resp = await axios.post(`${API}/agents/register`, {
        name: form.name,
        goal: form.goal,
        webhook_url: form.webhook_url,
        risk_envelope: {
          max_spend_usd: parseFloat(form.max_spend_usd),
          allowed_actions: form.allowed_actions.split(",").map(s => s.trim()),
          require_human_approval_above_usd: parseFloat(form.require_human_approval_above_usd)
        }
      });
      toast.success("Agent registered successfully.");
      setNewKey(resp.data.api_key);
      setOpen(false);
      setForm({ name: "", goal: "", webhook_url: "", max_spend_usd: "50.0", allowed_actions: "search,summarize,email", require_human_approval_above_usd: "100.0" });
      fetchAgents();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Registration failed");
    }
  };

  const renderInput = (label, name, type = "text", placeholder = "", min = undefined) => (
    <div>
      <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">{label}</label>
      <input
        data-testid={`register-${name}`}
        type={type}
        value={form[name]}
        onChange={(e) => setForm(prev => ({ ...prev, [name]: e.target.value }))}
        placeholder={placeholder}
        min={min}
        required={name === "name" || name === "mission_intent"}
        className="w-full bg-black border border-white/20 focus:border-avaira-primary text-white font-mono text-sm p-2 outline-none transition-colors"
      />
    </div>
  );

  return (
    <div className="page-shell animate-slide-in" data-testid="agent-registry-page">
      <div className="page-header">
        <div>
          <h1 className="page-title font-heading font-bold text-foreground uppercase tracking-tight">Agent Registry</h1>
          <p className="page-subtitle font-mono text-xs text-avaira-muted mt-1">{agents.length} AGENTS REGISTERED</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="refresh-agents-btn" onClick={fetchAgents} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
            <RefreshCw size={14} />
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button data-testid="register-agent-btn" className="cyber-btn bg-avaira-primary text-white px-4 py-2 font-heading text-sm flex items-center gap-2">
                <UserPlus size={14} /> REGISTER AGENT
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader>
                <DialogTitle className="font-heading font-bold text-lg text-foreground uppercase tracking-tight">Register New Agent</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleRegister} className="space-y-3 mt-2" data-testid="register-agent-form">
                {renderInput("Agent Name", "name", "text", "ResearchBot")}
                {renderInput("Primary Goal", "goal", "text", "Help with market research")}
                {renderInput("Webhook URL (optional)", "webhook_url", "text", "https://yourapp.com/webhooks")}
                <div className="border-t border-avaira-border pt-3">
                  <p className="font-heading font-semibold text-xs uppercase tracking-wider text-avaira-primary mb-2">Risk Envelope</p>
                  <div className="grid grid-cols-2 gap-3">
                    {renderInput("Max Spend (USD)", "max_spend_usd", "number", "", "0")}
                    {renderInput("Human Approval >", "require_human_approval_above_usd", "number", "", "0")}
                    <div className="col-span-2">
                      {renderInput("Allowed Actions (comma-sep)", "allowed_actions", "text", "search,email,summarize")}
                    </div>
                  </div>
                </div>
                <button data-testid="submit-register-btn" type="submit" className="w-full cyber-btn bg-avaira-primary text-white py-2 font-heading text-sm mt-2">
                  REGISTER & GET API KEY
                </button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <OperatorTools />

      <Dialog open={!!newKey} onOpenChange={() => setNewKey(null)}>
        <DialogContent className="bg-avaira-card border-avaira-primary border-2 rounded-none max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading font-bold text-lg text-avaira-primary uppercase tracking-tight flex items-center gap-2">
              <Shield size={18} /> API KEY GENERATED
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="font-mono text-xs text-foreground">
              This is the only time your API key will be shown. Store it securely.
            </p>
            <div className="bg-black border border-avaira-primary p-3 font-mono text-sm text-avaira-primary break-all select-all cursor-pointer" title="Click to copy" onClick={() => {
              navigator.clipboard.writeText(newKey);
              toast.success("API Key copied to clipboard");
            }}>
              {newKey}
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="w-full cyber-btn bg-avaira-primary text-white py-2 font-heading text-sm mt-2 uppercase"
            >
              I HAVE SAVED THE KEY
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="cyber-card p-12 text-center">
          <Zap size={40} className="text-avaira-dim mx-auto mb-3 animate-glow-pulse" strokeWidth={1} />
          <p className="font-heading text-lg text-avaira-muted uppercase">Loading Agents</p>
          <p className="font-mono text-xs text-avaira-dim mt-1">Pulling registry and score data from the protocol</p>
        </div>
      ) : agents.length === 0 ? (
        <div className="cyber-card p-12 text-center">
          <Shield size={40} className="text-avaira-dim mx-auto mb-3" strokeWidth={1} />
          <p className="font-heading text-lg text-avaira-muted uppercase">No Agents Registered</p>
          <p className="font-mono text-xs text-avaira-dim mt-1">Register an agent or run a simulation from the dashboard</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.map(agent => <AgentCard key={agent.id} agent={agent} onRefresh={fetchAgents} scores={scores} canManage={isAdmin} />)}
        </div>
      )}
    </div>
  );
}
