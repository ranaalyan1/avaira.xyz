import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion, RefreshCw, ArrowRight, Trash2, Search } from "lucide-react";

/**
 * Compliance — Cleanverse CVI/CVA gate.
 *
 * Reads live state from the CVI verification service (`services/cvi`,
 * REACT_APP_CVI_SERVICE_URL). Identity verification is structurally coupled to
 * asset movement: a CVA transfer reverts (CVI_MISSING / CVI_EXPIRED / CVI_REVOKED)
 * unless BOTH the originator and the beneficiary hold a valid wallet-bound CVI.
 */

const CVI_SERVICE = (process.env.REACT_APP_CVI_SERVICE_URL || "http://localhost:8301").replace(/\/$/, "");

const CVI_STATUS_META = {
  0: { label: "NO CREDENTIAL", color: "#FF003C", icon: ShieldQuestion, hint: "CVI_MISSING — nothing registered for this wallet" },
  1: { label: "VALID", color: "#39FF14", icon: ShieldCheck, hint: "wallet-bound CVI credential is live" },
  2: { label: "EXPIRED", color: "#FFD300", icon: ShieldAlert, hint: "CVI_EXPIRED — credential lapsed, re-verify" },
  3: { label: "REVOKED", color: "#FF003C", icon: ShieldX, hint: "CVI_REVOKED — credential revoked by the issuer" },
};

const GATE_REASONS = {
  0: "NONE — wallet holds a valid credential",
  1: "VALID",
  2: "EXPIRED — credential past its expiry",
  3: "REVOKED — credential revoked by issuer",
};

const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(value || "");
const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—");

function loadWatchlist() {
  try {
    const raw = localStorage.getItem("avaira.cvi.watchlist");
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted storage — fall through */ }
  return [];
}

function loadAttempts() {
  try {
    const raw = localStorage.getItem("avaira.cvi.attempts");
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted storage — fall through */ }
  return [];
}

export default function Compliance() {
  const [serviceOk, setServiceOk] = useState(null);
  const [serviceInfo, setServiceInfo] = useState(null);
  const [watchlist, setWatchlist] = useState(loadWatchlist);
  const [statuses, setStatuses] = useState({});
  const [walletInput, setWalletInput] = useState("");
  const [fromAddr, setFromAddr] = useState("");
  const [toAddr, setToAddr] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [attempts, setAttempts] = useState(loadAttempts);
  const [busy, setBusy] = useState(false);

  useEffect(() => { localStorage.setItem("avaira.cvi.watchlist", JSON.stringify(watchlist)); }, [watchlist]);
  useEffect(() => { localStorage.setItem("avaira.cvi.attempts", JSON.stringify(attempts.slice(0, 50))); }, [attempts]);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await axios.get(`${CVI_SERVICE}/health`, { timeout: 4000 });
      setServiceOk(true);
      setServiceInfo(res.data);
    } catch {
      setServiceOk(false);
      setServiceInfo(null);
    }
  }, []);

  const refreshStatuses = useCallback(async () => {
    if (watchlist.length === 0) { setStatuses({}); return; }
    const next = {};
    await Promise.all(watchlist.map(async (wallet) => {
      try {
        const res = await axios.get(`${CVI_SERVICE}/credential/${wallet}`, { timeout: 8000 });
        next[wallet] = { status: res.data.status, credential: res.data.credential };
      } catch {
        next[wallet] = { status: null, error: true };
      }
    }));
    setStatuses(next);
  }, [watchlist]);

  useEffect(() => {
    refreshHealth().then(() => refreshStatuses());
  }, [refreshHealth, refreshStatuses]);

  const addWallet = () => {
    const w = walletInput.trim();
    if (!isAddress(w)) return;
    if (!watchlist.some((x) => x.toLowerCase() === w.toLowerCase())) {
      setWatchlist([...watchlist, w]);
    }
    setWalletInput("");
  };

  const removeWallet = (wallet) => {
    setWatchlist(watchlist.filter((w) => w !== wallet));
    setStatuses((s) => { const { [wallet]: _, ...rest } = s; return rest; });
  };

  const runTransferCheck = async () => {
    if (!isAddress(fromAddr) || !isAddress(toAddr)) return;
    setBusy(true);
    setCheckResult(null);
    const attempt = { from: fromAddr, to: toAddr, at: new Date().toISOString() };
    try {
      const res = await axios.get(`${CVI_SERVICE}/transfer-check/${fromAddr}/${toAddr}`, { timeout: 10000 });
      const data = res.data;
      const record = {
        ...attempt,
        allowed: data.allowed,
        failing: data.failing,
        reason: data.reason,
      };
      setCheckResult(record);
      setAttempts([record, ...attempts]);
    } catch (err) {
      const record = { ...attempt, allowed: null, error: err?.response?.data?.error || err.message };
      setCheckResult(record);
      setAttempts([record, ...attempts]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-shell animate-slide-in" data-testid="compliance-page">
      <div className="page-header">
        <div>
          <h1 className="page-title font-heading font-bold text-foreground uppercase tracking-tight">Compliance</h1>
          <p className="page-subtitle font-mono text-xs text-avaira-muted mt-1">
            CLEANVERSE CVI / CVA — TRAVEL-RULE GATE
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-testid="cvi-service-status"
            className={`font-mono text-[10px] px-2 py-1 border ${serviceOk ? "border-[#39FF14]/40 text-[#39FF14]" : serviceOk === false ? "border-[#FF003C]/40 text-[#FF003C]" : "border-avaira-border text-avaira-muted"}`}
          >
            {serviceOk ? `CVI SERVICE · chain ${serviceInfo?.chainId ?? "?"}` : serviceOk === false ? "CVI SERVICE OFFLINE" : "CHECKING…"}
          </span>
          <button
            data-testid="refresh-compliance-btn"
            onClick={() => { refreshHealth(); refreshStatuses(); }}
            className="p-2 border border-avaira-border text-avaira-muted hover:text-avaira-primary hover:border-avaira-primary transition-colors"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Structural coupling explainer */}
      <div className="cyber-card corner-cut p-4 mb-4" data-testid="compliance-explainer">
        <p className="font-mono text-[11px] text-avaira-muted leading-relaxed">
          Identity verification is <span className="text-avaira-primary">structurally coupled to asset movement</span>:
          the CVA transfer path calls <span className="text-foreground">gateCVATransfer(from, to, amount)</span> and
          reverts with <span className="text-[#FF003C]">CVI_MISSING</span>, <span className="text-[#FFD300]">CVI_EXPIRED</span> or{" "}
          <span className="text-[#FF003C]">CVI_REVOKED</span> unless the originator <em>and</em> the beneficiary hold a valid
          wallet-bound Cleanverse CVI credential. Intents touching <span className="text-foreground">cva.*</span> are also
          blocked at the Avaira pre-execution gate with <span className="text-[#FFD300]">CVI_UNVERIFIED</span>.
        </p>
      </div>

      {/* Wallet CVI status watchlist */}
      <div className="cyber-card corner-cut p-4 mb-4" data-testid="cvi-watchlist">
        <h2 className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider mb-3">CVI Credential Status</h2>
        <div className="flex gap-2 mb-3">
          <input
            data-testid="cvi-wallet-input"
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addWallet()}
            placeholder="0x wallet address to watch…"
            className="flex-1 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
          />
          <button
            data-testid="cvi-add-wallet-btn"
            onClick={addWallet}
            disabled={!isAddress(walletInput)}
            className="px-4 py-2 border border-avaira-primary text-avaira-primary font-mono text-xs uppercase disabled:opacity-30 hover:bg-avaira-primary/10 transition-colors"
          >
            Track
          </button>
        </div>

        {watchlist.length === 0 ? (
          <p className="font-mono text-[11px] text-avaira-dim py-4 text-center">
            No wallets tracked yet — add an originator or beneficiary wallet above.
          </p>
        ) : (
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-avaira-dim text-[10px] uppercase tracking-wider border-b border-avaira-border">
                <th className="text-left py-2">Wallet</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2 hidden md:table-cell">Credential</th>
                <th className="text-left py-2 hidden md:table-cell">Expires</th>
                <th className="text-right py-2"></th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((wallet) => {
                const info = statuses[wallet];
                const meta = info && info.status !== null && info.status !== undefined ? CVI_STATUS_META[info.status] : null;
                const Icon = meta ? meta.icon : ShieldQuestion;
                return (
                  <tr key={wallet} className="border-b border-avaira-border/40">
                    <td className="py-2 text-foreground">{short(wallet)}</td>
                    <td className="py-2">
                      {meta ? (
                        <span className="inline-flex items-center gap-1.5" title={meta.hint} style={{ color: meta.color }}>
                          <Icon size={13} /> {meta.label}
                        </span>
                      ) : info?.error ? (
                        <span className="text-avaira-dim">unreachable</span>
                      ) : (
                        <span className="text-avaira-dim">loading…</span>
                      )}
                    </td>
                    <td className="py-2 hidden md:table-cell text-avaira-muted">
                      {info?.credential?.credentialHash && info.credential.credentialHash !== "0x0000000000000000000000000000000000000000000000000000000000000000"
                        ? `${info.credential.credentialHash.slice(0, 10)}…`
                        : "—"}
                    </td>
                    <td className="py-2 hidden md:table-cell text-avaira-muted">
                      {info?.credential?.expiry && BigInt(info.credential.expiry) > 0n
                        ? new Date(Number(BigInt(info.credential.expiry)) * 1000).toISOString().slice(0, 10)
                        : "—"}
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removeWallet(wallet)} className="text-avaira-dim hover:text-[#FF003C] transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Gated transfer simulator */}
      <div className="cyber-card corner-cut p-4 mb-4" data-testid="cvi-transfer-check">
        <h2 className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider mb-3">Gated Transfer Preflight</h2>
        <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-center">
          <input
            data-testid="cvi-from-input"
            value={fromAddr}
            onChange={(e) => setFromAddr(e.target.value)}
            placeholder="originator (from) 0x…"
            className="flex-1 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
          />
          <ArrowRight size={14} className="text-avaira-dim hidden md:block shrink-0" />
          <input
            data-testid="cvi-to-input"
            value={toAddr}
            onChange={(e) => setToAddr(e.target.value)}
            placeholder="beneficiary (to) 0x…"
            className="flex-1 bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-foreground focus:border-avaira-primary outline-none"
          />
          <button
            data-testid="cvi-check-btn"
            onClick={runTransferCheck}
            disabled={busy || !isAddress(fromAddr) || !isAddress(toAddr) || !serviceOk}
            className="px-4 py-2 border border-avaira-primary text-avaira-primary font-mono text-xs uppercase tracking-wider disabled:opacity-30 hover:bg-avaira-primary/10 transition-colors shrink-0"
          >
            {busy ? "Checking…" : "Gate Check"}
          </button>
        </div>

        {checkResult && (
          <div
            data-testid="cvi-check-result"
            className={`mt-3 p-3 border font-mono text-xs ${checkResult.allowed ? "border-[#39FF14]/40 text-[#39FF14]" : "border-[#FF003C]/40 text-[#FF003C]"}`}
          >
            {checkResult.allowed === true && <span className="inline-flex items-center gap-2"><ShieldCheck size={14} /> ALLOWED — both parties hold valid CVI credentials</span>}
            {checkResult.allowed === false && (
              <span className="inline-flex items-center gap-2">
                <ShieldX size={14} /> BLOCKED — failing party {short(checkResult.failing)} ({GATE_REASONS[checkResult.reason] ?? `reason ${checkResult.reason}`});
                on-chain this reverts with CVI_{(GATE_REASONS[checkResult.reason] || "MISSING").split(" ")[0]}
              </span>
            )}
            {checkResult.allowed === null && (
              <span className="inline-flex items-center gap-2 text-avaira-muted"><ShieldQuestion size={14} /> {checkResult.error}</span>
            )}
          </div>
        )}
      </div>

      {/* Recent gated transfer attempts */}
      <div className="cyber-card corner-cut p-4" data-testid="cvi-attempts">
        <h2 className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider mb-3">Gated Transfer Attempts</h2>
        {attempts.length === 0 ? (
          <p className="font-mono text-[11px] text-avaira-dim py-4 text-center flex items-center justify-center gap-2">
            <Search size={13} /> No gate checks recorded yet — run a preflight above.
          </p>
        ) : (
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-avaira-dim text-[10px] uppercase tracking-wider border-b border-avaira-border">
                <th className="text-left py-2">Time</th>
                <th className="text-left py-2">Route</th>
                <th className="text-left py-2">Decision</th>
                <th className="text-left py-2 hidden md:table-cell">Rejection Reason</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a, i) => (
                <tr key={`${a.at}-${i}`} className="border-b border-avaira-border/40">
                  <td className="py-2 text-avaira-muted">{new Date(a.at).toLocaleTimeString()}</td>
                  <td className="py-2 text-foreground">{short(a.from)} <ArrowRight size={10} className="inline text-avaira-dim" /> {short(a.to)}</td>
                  <td className="py-2">
                    {a.allowed === true && <span className="text-[#39FF14]">ALLOWED</span>}
                    {a.allowed === false && <span className="text-[#FF003C]">BLOCKED</span>}
                    {a.allowed === null && <span className="text-avaira-dim">ERROR</span>}
                  </td>
                  <td className="py-2 hidden md:table-cell text-avaira-muted">
                    {a.allowed === false ? GATE_REASONS[a.reason] ?? `reason ${a.reason}` : a.error || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
