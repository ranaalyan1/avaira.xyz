import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Code, Terminal, Copy, Check, ChevronRight, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";

import { API } from "@/lib/api";

import { DARK } from "@/lib/palette";
import { copyText } from "@/lib/clipboard";

const CopyBtn = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    /* copyText resolves false instead of rejecting when the clipboard API is
     * missing (plain-http deployments) or the copy is blocked. */
    const ok = await copyText(text);
    if (!ok) {
      toast.error("Could not copy — select the snippet and copy it manually");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Copied to clipboard");
  };
  return (
    <button data-testid="copy-btn" onClick={handle} className="p-1 text-avaira-muted hover:text-avaira-primary transition-colors">
      {copied ? <Check size={12} className="text-avaira-green" /> : <Copy size={12} />}
    </button>
  );
};

const CodeBlock = ({ code, lang = "typescript" }) => (
  <div className="relative bg-black border border-avaira-border overflow-x-auto">
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-avaira-border">
      <span className="font-mono text-[9px] text-avaira-dim uppercase tracking-widest">{lang}</span>
      <CopyBtn text={code} />
    </div>
    <pre className="p-4 font-mono text-xs text-avaira-green whitespace-pre leading-relaxed overflow-x-auto">{code}</pre>
  </div>
);

export default function SDKDocs() {
  const [docs, setDocs] = useState(null);
  const [activeFunc, setActiveFunc] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    axios
      .get(`${API}/sdk/docs`)
      .then((res) => { if (!cancelled) setDocs(res.data); })
      .catch((err) => {
        /* Previously this only logged: with no backend the request fails and
         * the page pulses "Loading SDK docs…" forever. */
        if (!cancelled) setError(err?.message || "The SDK docs request failed.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => { setActiveFunc(0); }, [docs]);

  if (loading && !docs) return (
    <div className="flex items-center justify-center h-64">
      <p className="font-mono text-xs text-avaira-muted animate-glow-pulse">Loading SDK docs…</p>
    </div>
  );

  if (error && !docs) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3" data-testid="sdk-docs-error">
      <Unplug size={28} className="text-avaira-red" strokeWidth={1.5} />
      <p className="text-[15px] font-medium text-avaira-muted">SDK reference unavailable</p>
      <p className="max-w-md text-center font-mono text-xs text-avaira-dim">
        The reference is served by <code>GET /api/sdk/docs</code>, which this deployment did not answer.
        {error ? ` ${error}` : ""}
      </p>
      <button
        type="button"
        onClick={retry}
        data-testid="sdk-docs-retry"
        className="cyber-btn mt-1 flex items-center gap-2 px-3 py-1.5 font-mono text-[11px]"
      >
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  );

  /* A back end that answers with a partial document must not crash the page. */
  const install = docs?.install || {};
  const functions = Array.isArray(docs?.functions) ? docs.functions : [];

  return (
    <div className="page-shell animate-slide-in" data-testid="sdk-docs-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">SDK Documentation</h1>
          <p className="page-subtitle">Integrate in four function calls</p>
        </div>
      </div>

      {/* Install */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="cyber-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Terminal size={14} className="text-avaira-primary" />
            <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">TypeScript Installation</span>
          </div>
          <CodeBlock code={install.typescript || ""} lang="bash" />
        </div>
        <div className="cyber-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Terminal size={14} className="text-avaira-primary" />
            <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest">Rust Installation</span>
          </div>
          <CodeBlock code={install.rust || ""} lang="bash" />
        </div>
      </div>

      {/* Quick Start */}
      <div className="cyber-card p-4 mb-6">
        <h2 className="text-[13px] font-semibold tracking-tight text-avaira-primary mb-3 flex items-center gap-2">
          <Code size={14} /> Quick Start
        </h2>
        <CodeBlock code={docs?.quick_start || ""} lang="typescript" />
      </div>

      {/* Function Reference */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Function Nav */}
        <div className="space-y-1.5">
          <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">API reference</h2>
          {functions.map((fn, i) => (
            <button
              key={fn.name}
              data-testid={`sdk-func-${fn.name}`}
              onClick={() => setActiveFunc(i)}
              className={`w-full text-left p-3 border transition-colors flex items-center justify-between ${
                activeFunc === i ? 'border-avaira-primary bg-avaira-primary/5 text-avaira-primary' : 'border-avaira-border text-avaira-muted hover:border-avaira-primary/30 hover:text-foreground'
              }`}
            >
              <div>
                <p className="font-mono text-sm">.{fn.name}()</p>
                <p className="font-mono text-[10px] text-avaira-dim mt-0.5">{fn.description}</p>
              </div>
              <ChevronRight size={14} className={activeFunc === i ? 'text-avaira-primary' : 'text-avaira-dim'} />
            </button>
          ))}
        </div>

        {/* Function Detail */}
        <div className="lg:col-span-2 cyber-card p-4">
          {functions[activeFunc] && (
            <div data-testid="sdk-func-detail">
              <div className="flex items-center gap-3 mb-4">
                <span className="font-heading font-bold text-2xl text-avaira-primary">.{functions[activeFunc].name}()</span>
              </div>
              <p className="font-body text-sm text-avaira-muted mb-4">{functions[activeFunc].description || ""}</p>

              {/* Parameters */}
              <div className="mb-4">
                <h3 className="text-[11px] font-semibold tracking-tight text-avaira-muted mb-2">Parameters</h3>
                <div className="space-y-1">
                  {(functions[activeFunc].params || []).map((p, i) => (
                    <div key={i} className="flex items-center gap-3 p-2 bg-black/40">
                      <code className="font-mono text-xs text-avaira-primary">{p.name}</code>
                      <code className="font-mono text-[10px] text-avaira-purple">{p.type}</code>
                    </div>
                  ))}
                </div>
              </div>

              {/* Returns */}
              <div className="mb-4">
                <h3 className="text-[11px] font-semibold tracking-tight text-avaira-muted mb-2">Returns</h3>
                <div className="p-2 bg-black/40">
                  <code className="font-mono text-xs text-avaira-green">{functions[activeFunc].returns || "—"}</code>
                </div>
              </div>

              {/* Example */}
              <div>
                <h3 className="text-[11px] font-semibold tracking-tight text-avaira-muted mb-2">Example</h3>
                <CodeBlock code={functions[activeFunc].example || ""} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Fee structure */}
      <div className="cyber-card p-4 mt-6">
        <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Fee structure</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-3 border border-avaira-border">
            <p className="font-heading font-bold text-lg text-avaira-green">85%</p>
            <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest mt-0.5">Agent Payout</p>
            <p className="font-mono text-[10px] text-avaira-dim mt-1">The AI agent earns the majority of the mission value</p>
          </div>
          <div className="p-3 border border-avaira-border">
            <p className="font-heading font-bold text-lg text-avaira-primary">10%</p>
            <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest mt-0.5">Underwriter Yield</p>
            <p className="font-mono text-[10px] text-avaira-dim mt-1">Human underwriters earn yield for backing the mission</p>
          </div>
          <div className="p-3 border border-avaira-border">
            <p className="font-heading font-bold text-lg text-avaira-purple">5%</p>
            <p className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest mt-0.5">Protocol Fee</p>
            <p className="font-mono text-[10px] text-avaira-dim mt-1">AVAIRA protocol fee for settlement infrastructure</p>
          </div>
        </div>
      </div>

      {/* Scoring Reference */}
      <div className="cyber-card p-4 mt-4">
        <h2 className="text-[13px] font-semibold tracking-tight text-avaira-muted mb-3">Avaira score reference</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[
            { grade: 'AAA', range: '90-100', color: DARK.success },
            { grade: 'AA', range: '80-89', color: DARK.info },
            { grade: 'A', range: '70-79', color: DARK.info },
            { grade: 'BBB', range: '60-69', color: DARK.warning },
            { grade: 'BB', range: '50-59', color: DARK.warning },
            { grade: 'B', range: '40-49', color: DARK.warning },
            { grade: 'CCC', range: '30-39', color: DARK.danger },
            { grade: 'D', range: '0-29', color: DARK.danger },
          ].map(g => (
            <div key={g.grade} className="p-2 border border-avaira-border text-center">
              <p className="font-heading font-bold text-lg" style={{ color: g.color }}>{g.grade}</p>
              <p className="font-mono text-[9px] text-avaira-dim">{g.range}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
