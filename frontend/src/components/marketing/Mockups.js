/**
 * Product mockups for the marketing pages.
 *
 * These are pure CSS/HTML — no screenshots — so they stay sharp at any
 * resolution, add nothing to the bundle, and can never drift from the copy.
 * They deliberately render the *dark console* on top of the light marketing
 * canvas: the product is a dark operator surface, and showing it truthfully is
 * the point of the frame.
 */
import { DARK } from "@/lib/palette";
import { ShieldCheck, Activity, Users, Wallet, TrendingUp, Workflow, Ban, Check } from "lucide-react";

const S = {
    bg: DARK.app,
    card: DARK.card,
    raised: DARK.raised,
    hairline: DARK.hairline,
    text: DARK.textPrimary,
    dim: DARK.textSecondary,
    muted: DARK.textMuted,
    accent: DARK.accent,
    success: DARK.success,
    warning: DARK.warning,
    danger: DARK.danger,
    info: DARK.info,
    violet: DARK.violet,
    mono: "'JetBrains Mono', monospace",
};

export function WindowFrame({ url = "app.avaira.xyz/dashboard", children, className = "" }) {
    return (
        <div className={`mk-window ${className}`} aria-hidden="true">
            <div className="mk-window-bar">
                <span className="mk-dot" />
                <span className="mk-dot" />
                <span className="mk-dot" />
                <span
                    className="ml-3 truncate rounded-md px-2.5 py-1 text-[11px]"
                    style={{ background: "rgb(var(--surface-card))", border: "1px solid rgb(var(--hairline))", color: "rgb(var(--text-muted))", fontFamily: S.mono }}
                >
                    {url}
                </span>
            </div>
            <div style={{ background: S.bg }}>{children}</div>
        </div>
    );
}

const NavRow = ({ icon: Icon, label, active }) => (
    <div
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px]"
        style={{
            background: active ? "rgba(110,107,242,0.14)" : "transparent",
            color: active ? S.accent : S.dim,
        }}
    >
        <Icon size={12} strokeWidth={1.75} />
        <span style={{ fontFamily: S.mono, letterSpacing: "0.02em" }}>{label}</span>
    </div>
);

const StatTile = ({ label, value, tone = S.text }) => (
    <div className="rounded-lg p-3" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
        <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: S.muted, fontFamily: S.mono }}>{label}</p>
        <p className="mt-1 text-lg font-semibold" style={{ color: tone, fontFamily: S.mono }}>{value}</p>
    </div>
);

const StatusPill = ({ children, tone }) => (
    <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px]"
        style={{ background: `${tone}1f`, color: tone, border: `1px solid ${tone}40`, fontFamily: S.mono }}
    >
        {children}
    </span>
);

const BARS = [34, 52, 41, 63, 48, 72, 58, 84, 66, 91, 76, 96];

/** The protocol console: live telemetry, executions and risk state. */
export function MockConsole() {
    return (
        <div className="flex min-h-[340px] text-[11px]" style={{ background: S.bg }}>
            <aside className="hidden w-40 shrink-0 flex-col gap-1 p-3 sm:flex" style={{ borderRight: `1px solid ${S.hairline}` }}>
                <div className="mb-2 flex items-center gap-2 px-1">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold" style={{ background: S.accent, color: "#fff" }}>A</span>
                    <span className="font-semibold" style={{ color: S.text }}>AVAIRA</span>
                </div>
                <NavRow icon={Activity} label="DASHBOARD" active />
                <NavRow icon={Users} label="AGENT REGISTRY" />
                <NavRow icon={Workflow} label="EXECUTION FLOW" />
                <NavRow icon={Ban} label="FREEZE / SLASH" />
                <NavRow icon={Wallet} label="TREASURY" />
                <NavRow icon={TrendingUp} label="REPUTATION" />
            </aside>

            <div className="flex-1 p-3.5">
                <div className="flex items-center justify-between pb-3" style={{ borderBottom: `1px solid ${S.hairline}` }}>
                    <div>
                        <p className="text-[10px] uppercase tracking-[0.16em]" style={{ color: S.muted, fontFamily: S.mono }}>Control panel</p>
                        <p className="text-sm font-semibold" style={{ color: S.text }}>Protocol telemetry</p>
                    </div>
                    <StatusPill tone={S.success}>● ONLINE</StatusPill>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <StatTile label="Agents" value="1,284" />
                    <StatTile label="Executions" value="86,410" />
                    <StatTile label="Avg score" value="87.4" tone={S.accent} />
                    <StatTile label="Frozen" value="3" tone={S.danger} />
                </div>

                <div className="mt-2 rounded-lg p-3" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                    <div className="flex items-center justify-between">
                        <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: S.muted, fontFamily: S.mono }}>Settled value · 12h</p>
                        <span className="text-[10px]" style={{ color: S.success, fontFamily: S.mono }}>+18.2%</span>
                    </div>
                    <div className="mt-3 flex h-24 items-end gap-1.5">
                        {BARS.map((h, i) => (
                            <div
                                key={i}
                                className="flex-1 rounded-sm"
                                style={{ height: `${h}%`, background: i > 8 ? S.accent : "rgba(110,107,242,0.35)" }}
                            />
                        ))}
                    </div>
                </div>

                <div className="mt-2 hidden rounded-lg sm:block" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                    {[
                        ["exec_9f2c", "search.market_data", "$12.40", S.success, "SETTLED"],
                        ["exec_9f2b", "transfer.usdc", "$840.00", S.warning, "REVIEW"],
                        ["exec_9f2a", "trade.swap", "$2,140.00", S.danger, "BLOCKED"],
                    ].map(([id, action, value, tone, label], i) => (
                        <div
                            key={id}
                            className="flex items-center justify-between px-3 py-2"
                            style={{ borderTop: i === 0 ? "none" : `1px solid ${S.hairline}` }}
                        >
                            <span style={{ color: S.muted, fontFamily: S.mono }}>{id}</span>
                            <span style={{ color: S.dim, fontFamily: S.mono }}>{action}</span>
                            <span style={{ color: S.text, fontFamily: S.mono }}>{value}</span>
                            <StatusPill tone={tone}>{label}</StatusPill>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

const GATE_CHECKS = [
    ["Risk envelope", "max_spend_usd 50.00 · allowed search, read"],
    ["Deterministic policy (OPA)", "shield_rules.rego · deny transfer"],
    ["Symbolic prover", "interval arithmetic · no violations"],
    ["TEE attestation", "execution image digest verified"],
];

/** The pre-execution gate: intent in, permit or freeze out. */
export function MockGate() {
    return (
        <div className="p-3.5 text-[11px]" style={{ background: S.bg }}>
            <div className="flex items-center gap-2">
                <ShieldCheck size={14} color={S.accent} />
                <span className="font-semibold" style={{ color: S.text }}>Pre-execution gate</span>
                <span className="ml-auto" style={{ color: S.muted, fontFamily: S.mono }}>intent · #9f2c</span>
            </div>

            <div className="mt-3 rounded-lg p-3" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                <div className="grid grid-cols-3 gap-2">
                    {[["action", "transfer.usdc"], ["target", "0x9B95…65b7"], ["value_usd", "840.00"]].map(([k, v]) => (
                        <div key={k}>
                            <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: S.muted, fontFamily: S.mono }}>{k}</p>
                            <p className="mt-0.5 truncate" style={{ color: S.text, fontFamily: S.mono }}>{v}</p>
                        </div>
                    ))}
                </div>
            </div>

            <div className="mt-2 rounded-lg" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                {GATE_CHECKS.map(([title, detail], i) => (
                    <div key={title} className="flex items-start gap-2.5 px-3 py-2" style={{ borderTop: i === 0 ? "none" : `1px solid ${S.hairline}` }}>
                        <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full" style={{ background: "rgba(52,211,153,0.16)", color: S.success }}>
                            <Check size={10} strokeWidth={3} />
                        </span>
                        <div>
                            <p style={{ color: S.text }}>{title}</p>
                            <p className="text-[10px]" style={{ color: S.muted, fontFamily: S.mono }}>{detail}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="mt-2 flex items-center justify-between rounded-lg px-3 py-2.5" style={{ background: "rgba(244,91,105,0.08)", border: `1px solid rgba(244,91,105,0.3)` }}>
                <span style={{ color: S.danger }}>Deviation detected — execution blocked</span>
                <span style={{ color: S.danger, fontFamily: S.mono }}>184ms</span>
            </div>
        </div>
    );
}

const AGENTS = [
    ["atlas-04", "AAA", 96, S.success, "ACTIVE"],
    ["orion-11", "AA", 89, S.accent, "ACTIVE"],
    ["kepler-02", "BBB", 72, S.warning, "PAUSED"],
    ["vega-07", "D", 41, S.danger, "FROZEN"],
];

/** Agent registry: scores, statuses and a trust heatmap strip. */
export function MockRegistry() {
    return (
        <div className="p-3.5 text-[11px]" style={{ background: S.bg }}>
            <div className="flex items-center justify-between pb-2.5" style={{ borderBottom: `1px solid ${S.hairline}` }}>
                <span className="font-semibold" style={{ color: S.text }}>Agent registry</span>
                <span style={{ color: S.muted, fontFamily: S.mono }}>1,284 registered</span>
            </div>

            <div className="mt-2.5 rounded-lg" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                {AGENTS.map(([id, grade, score, tone, status], i) => (
                    <div key={id} className="flex items-center justify-between px-3 py-2.5" style={{ borderTop: i === 0 ? "none" : `1px solid ${S.hairline}` }}>
                        <span style={{ color: S.text, fontFamily: S.mono }}>{id}</span>
                        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: tone, border: `1px solid ${tone}55`, fontFamily: S.mono }}>{grade}</span>
                        <div className="hidden h-1.5 w-28 overflow-hidden rounded-full sm:block" style={{ background: S.raised }}>
                            <div style={{ width: `${score}%`, height: "100%", background: tone }} />
                        </div>
                        <span style={{ color: S.muted, fontFamily: S.mono }}>{score}</span>
                        <StatusPill tone={tone}>{status}</StatusPill>
                    </div>
                ))}
            </div>

            <div className="mt-2.5 rounded-lg p-3" style={{ background: S.card, border: `1px solid ${S.hairline}` }}>
                <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: S.muted, fontFamily: S.mono }}>Trust heatmap · 14 days</p>
                <div className="mt-2 flex gap-0.5">
                    {Array.from({ length: 28 }).map((_, i) => {
                        const tones = ["rgba(52,211,153,0.85)", "rgba(110,107,242,0.7)", "rgba(245,181,68,0.7)", "rgba(244,91,105,0.75)"];
                        const t = tones[i % 7 === 3 ? 2 : i % 11 === 5 ? 3 : i % 3 === 0 ? 1 : 0];
                        return <div key={i} className="h-6 flex-1 rounded-sm" style={{ background: t }} />;
                    })}
                </div>
            </div>
        </div>
    );
}
