import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Send, CheckCircle, XCircle, Clock, FileKey, Shield, Zap, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";

import { API } from "@/lib/api";
import ConsoleError from "@/components/ConsoleError";

import { DARK } from "@/lib/palette";
import { num, text, timeLabel, dateLabel, toNumber } from "@/lib/format";

const STEP_ICONS = { request_submitted: Send, risk_validation: Shield, execution: Zap, fee_deducted: Clock };

const TimelineStep = ({ step, isLast }) => {
  const Icon = STEP_ICONS[step.step] || Clock;
  const isComplete = step.status === "completed" || step.approved === true;
  const isFailed = step.status === "failed" || step.approved === false;

  return (
    <div className="flex gap-3 relative" data-testid={`timeline-step-${step.step}`}>
      <div className="flex flex-col items-center">
        <div className={`timeline-dot ${isComplete ? 'completed' : isFailed ? 'failed' : ''}`} />
        {!isLast && <div className="w-[2px] flex-1 min-h-[24px]" style={{ background: isComplete ? 'rgb(var(--accent) / 0.35)' : 'rgb(var(--hairline) / 0.6)' }} />}
      </div>
      <div className="pb-4 flex-1">
        <div className="flex items-center gap-2">
          <Icon size={12} strokeWidth={1.5} className={isComplete ? 'text-avaira-primary' : isFailed ? 'text-avaira-red' : 'text-avaira-muted'} />
          <span className="font-mono text-xs uppercase tracking-wider" style={{ color: isComplete ? DARK.accent : isFailed ? DARK.danger : DARK.textMuted }}>
            {text(step.step, "step").replace(/_/g, ' ')}
          </span>
          <span className={`font-mono text-[10px] px-1.5 py-0.5 border ${isComplete ? 'border-green-500/30 text-green-400' : isFailed ? 'border-red-500/30 text-red-400' : 'border-white/10 text-avaira-muted'}`}>
            {step.status}
          </span>
        </div>
        <p className="font-mono text-[11px] text-avaira-muted mt-1">{step.details}</p>
        <p className="font-mono text-[9px] text-avaira-dim mt-0.5">{dateLabel(step.timestamp, { withTime: true })}</p>
      </div>
    </div>
  );
};

export default function ExecutionFlow() {
  const [executions, setExecutions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedExec, setSelectedExec] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [open, setOpen] = useState(false);
  /* Robinhood Chain testnet — the chain every deployment in this repository
   * lives on. The form used to default to 43113 (Avalanche Fuji), so a request
   * created from the console named a chain the contracts are not on. */
  const [form, setForm] = useState({ agent_id: "", action: "swap", target_address: "", value: "1.0", chain_id: "4663" });

  const fetchData = useCallback(async () => {
    try {
      const [execRes, agentRes] = await Promise.all([
        axios.get(`${API}/executions`),
        axios.get(`${API}/agents`)
      ]);
      setExecutions(execRes.data);
      setAgents(agentRes.data);
      setLoadError(null);
    } catch (e) { setLoadError(e?.message || "The executions API did not respond."); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.agent_id) return toast.error("Select an agent");
    try {
      const res = await axios.post(`${API}/executions/request`, {
        agent_id: form.agent_id,
        action: form.action,
        target_address: form.target_address || "0x" + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
        value: parseFloat(form.value),
        chain_id: form.chain_id
      });
      toast.success(`Execution ${res.data.status}`);
      setOpen(false);
      fetchData();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Execution request failed");
    }
  };

  const statusColor = (status) => {
    const value = text(status, "");
    if (value === 'completed') return DARK.success;
    if (value.includes('rejected') || value.includes('invalid')) return DARK.danger;
    return DARK.warning;
  };

  return (
    <div className="page-shell animate-slide-in" data-testid="execution-flow-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Execution Flow</h1>
          <p className="page-subtitle">{executions.length} executions recorded</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <input
              type="text"
              placeholder="Search audit IDs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-black border border-avaira-border px-3 py-1.5 font-mono text-[10px] text-white w-48 outline-none focus:border-avaira-primary"
            />
          </div>
          <button data-testid="refresh-executions-btn" onClick={fetchData} className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors">
            <RefreshCw size={14} />
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button data-testid="new-execution-btn" className="cyber-btn flex items-center gap-2 px-3.5 py-2 text-[13px]">
                <Send size={14} /> NEW EXECUTION
              </button>
            </DialogTrigger>
            <DialogContent className="bg-avaira-card border-avaira-border rounded-none max-w-md">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">Submit Execution Request</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-3 mt-2" data-testid="execution-request-form">
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Agent</label>
                  <select
                    data-testid="exec-agent-select"
                    value={form.agent_id}
                    onChange={(e) => setForm(p => ({ ...p, agent_id: e.target.value }))}
                    className="w-full bg-black border border-white/20 focus:border-avaira-primary text-white font-mono text-sm p-2 outline-none"
                  >
                    <option value="">Select agent...</option>
                    {agents.filter(a => a.status === 'active').map(a => (
                      <option key={a.id} value={a.id}>{a.name} (Rep: {a.reputation})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Action</label>
                  <select
                    data-testid="exec-action-select"
                    value={form.action}
                    onChange={(e) => setForm(p => ({ ...p, action: e.target.value }))}
                    className="w-full bg-black border border-white/20 focus:border-avaira-primary text-white font-mono text-sm p-2 outline-none"
                  >
                    {["transfer", "swap", "stake", "unstake", "liquidate", "bridge"].map(a => (
                      <option key={a} value={a}>{a.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Value (USD)</label>
                  <input
                    data-testid="exec-value-input"
                    type="number"
                    step="0.01"
                    value={form.value}
                    onChange={(e) => setForm(p => ({ ...p, value: e.target.value }))}
                    className="w-full bg-black border border-white/20 focus:border-avaira-primary text-white font-mono text-sm p-2 outline-none"
                  />
                </div>
                <div>
                  <label className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">Target Address</label>
                  <input
                    data-testid="exec-target-input"
                    type="text"
                    value={form.target_address}
                    onChange={(e) => setForm(p => ({ ...p, target_address: e.target.value }))}
                    placeholder="0x... (auto-generated if empty)"
                    className="w-full bg-black border border-white/20 focus:border-avaira-primary text-white font-mono text-sm p-2 outline-none"
                  />
                </div>
                <button data-testid="submit-execution-btn" type="submit" className="w-full cyber-btn bg-avaira-primary text-white py-2 font-heading text-sm">
                  SUBMIT EXECUTION REQUEST
                </button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <ConsoleError
        message={loadError}
        onRetry={fetchData}
        title="Execution data unavailable"
        testid="executions-error"
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Execution List */}
        <div className="lg:col-span-2 cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Execution history</h2>
          {executions.length === 0 ? (
            <div className="text-center py-8">
              <Zap size={32} className="text-avaira-dim mx-auto mb-2" strokeWidth={1} />
              <p className="font-mono text-xs text-avaira-dim">NO EXECUTIONS</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full data-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Action</th>
                    <th className="text-right">Value</th>
                    <th className="text-right">Fee</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.filter(ex => !searchTerm || (ex.audit_id && ex.audit_id.toLowerCase().includes(searchTerm.toLowerCase()))).map(ex => (
                    <tr key={ex.id} className="cursor-pointer" onClick={() => setSelectedExec(ex)} data-testid={`exec-row-${ex.id}`}>
                      <td className="text-foreground">
                        {text(ex.agent_name, "unknown")}
                        {ex.audit_id && <span className="block text-[8px] text-avaira-dim">{ex.audit_id}</span>}
                      </td>
                      <td className="uppercase text-avaira-primary">{text(ex.action, "—")}</td>
                      <td className="text-right text-foreground">{num(ex.value, 4)}</td>
                      <td className="text-right text-avaira-yellow">{num(ex.fee_deducted, 6)}</td>
                      <td>
                        <span className="font-mono text-[10px] px-1.5 py-0.5 border" style={{ borderColor: statusColor(ex.status) + '40', color: statusColor(ex.status) }}>
                          {text(ex.status, "unknown").replace(/_/g, ' ').toUpperCase()}
                        </span>
                      </td>
                      <td className="text-avaira-dim">{timeLabel(ex.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Timeline Detail */}
        <div className="cyber-card p-4">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Execution lifecycle</h2>
          {selectedExec ? (
            <div data-testid="execution-timeline">
              <div className="mb-3 pb-3 border-b border-avaira-border">
                <p className="font-mono text-xs text-avaira-primary">{text(selectedExec.agent_name, "unknown")}</p>
                <div className="flex justify-between items-center mt-1">
                   <p className="font-mono text-[10px] text-avaira-muted">ID: {text(selectedExec.id, "—").slice(0, 8)}...</p>
                   {selectedExec.audit_id && (
                     <span className="font-mono text-[9px] px-1.5 py-0.5 bg-avaira-primary/10 text-avaira-primary border border-avaira-primary/20">
                        {selectedExec.audit_id}
                     </span>
                   )}
                </div>
              </div>
              <div className="relative">
                {(selectedExec.lifecycle || []).map((step, i) => (
                  <TimelineStep key={i} step={step} isLast={i === (selectedExec.lifecycle || []).length - 1} />
                ))}
              </div>

              {selectedExec.status === "blocked" && (
                <div className="mt-4 p-3 border border-red-500/50 bg-red-500/10 animate-pulse">
                  <p className="text-[12px] font-semibold tracking-tight text-avaira-red flex items-center gap-2">
                    <Shield size={14} /> Execution Shield Intercept
                  </p>
                  <p className="font-mono text-[11px] text-red-200 mt-2">
                    REASON: {selectedExec.reason || "Rule violation detected by OPA/SLM"}
                  </p>
                  <p className="font-mono text-[9px] text-red-400/70 mt-1 uppercase">
                    Deterministic Math > LLM Probabilities
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="font-mono text-xs text-avaira-dim">SELECT AN EXECUTION</p>
              <p className="font-mono text-[10px] text-avaira-dim mt-1">Click a row to view lifecycle</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
