import { useNavigate } from "react-router-dom";
import {
  Shield, FileKey, Heart, Zap, TrendingUp, Lock, Database, Globe, ChevronRight,
  Code, Users, Wallet, ArrowRight, LogIn, Check, Ban, ShieldCheck,
  Fingerprint, Gavel, ScrollText, Boxes, Github,
} from "lucide-react";
import { useAuth } from "@/App";
import { MockConsole, MockGate, MockRegistry, WindowFrame } from "@/components/marketing/Mockups";

const PILLARS = [
  { icon: TrendingUp, title: "RATE", subtitle: "The Moody’s function", color: "var(--accent)", tone: "avaira-primary", desc: "Every AI agent gets an Avaira Score (AAA to D). No enterprise will trust an unrated agent. The rating becomes the standard.", stat: "$50B+ market" },
  { icon: FileKey, title: "CLEAR", subtitle: "The DTCC function", color: "var(--success)", tone: "avaira-green", desc: "Every agent transaction passes through our settlement layer. We see every execution. Unmatched data. Unmatched risk models.", stat: "$2.5Q processed/yr" },
  { icon: Heart, title: "INSURE", subtitle: "The Lloyd’s function", color: "var(--violet)", tone: "avaira-purple", desc: "Human underwriters stake capital against agent missions. Agent fails → collateral covers losses. Agent succeeds → underwriters earn yield.", stat: "$100B+ in premiums" },
];

const MOATS = [
  { icon: Database, title: "Data flywheel", desc: "More agents → better risk models → more accurate scores → more enterprises → more agents. The gap widens over time." },
  { icon: Lock, title: "Regulatory capture", desc: "Define the standard before regulators do. Regulation doesn’t kill you. Regulation is you." },
  { icon: Users, title: "Three-sided network", desc: "Agents, underwriters and enterprises. Three-sided network effects are nearly impossible to replicate." },
  { icon: Shield, title: "Switching costs", desc: "Behavioural history, Avaira Score, insurance coverage, enterprise contracts. Switching cost: 6+ months. Nobody switches." },
  { icon: Globe, title: "High-performance infrastructure", desc: "Sub-200ms finality. Sovereign rules. Optimised execution. The speed a real-time circuit breaker requires." },
];

const STEPS = [
  { step: "01", label: "Register", desc: "Agent stakes collateral" },
  { step: "02", label: "Declare", desc: "Submit mission intent" },
  { step: "03", label: "Validate", desc: "Risk envelope check" },
  { step: "04", label: "Permit", desc: "EIP-712 signed" },
  { step: "05", label: "Execute", desc: "Verified execution" },
  { step: "06", label: "Settle", desc: "Fees split 85/10/5" },
];

const REVENUE = [
  { name: "Agent registration", year1: "$1.2M", year5: "$240M", desc: "SaaS tiers: Free / Growth ($200/mo) / Enterprise ($2,000/mo)" },
  { name: "Underwriting spread", year1: "$2M", year5: "$400M", desc: "5% protocol fee on every settled mission" },
  { name: "Slashing revenue", year1: "$500K", year5: "$50M", desc: "20% of all slashed collateral — pure insurance profit" },
  { name: "Data & analytics", year1: "$300K", year5: "$80M", desc: "Bloomberg terminal for AI agents. $0.01/query API access" },
];

const STANDARDS = [
  { icon: Fingerprint, name: "ERC-8004", desc: "Bond-backed agent identity and on-chain status" },
  { icon: Wallet, name: "x402", desc: "Agent payments settle where the work happens" },
  { icon: ScrollText, name: "EIP-712", desc: "Typed, signed execution permits" },
  { icon: Gavel, name: "OPA Rego", desc: "Policies as versioned, testable files" },
  { icon: Boxes, name: "EVM chains", desc: "Fuji deployment addresses, Monad deploy script" },
  { icon: ShieldCheck, name: "TEE attestation", desc: "Execution image digests verified, not assumed" },
];

const DIFFERENTIATORS = [
  { icon: ShieldCheck, title: "Pre-execution, not post-hoc", desc: "The gate runs before your code touches capital, not after the logs look strange." },
  { icon: FileKey, title: "Signed permits, not prompts", desc: "Every approved action carries a typed, verifiable permit." },
  { icon: Lock, title: "Tamper-evident, not mutable", desc: "Hash-chained local trail with a Merkle root committed on-chain." },
  { icon: Ban, title: "Consequences, not alerts", desc: "Freeze, slash and credit-freeze happen automatically, in under 200ms." },
];

const OWNERSHIP = [
  { title: "Bring your own model", desc: "Nothing in the gate depends on which LLM produced the intent." },
  { title: "Self-host or managed", desc: "The full stack runs from docker-compose on your own infrastructure." },
  { title: "No framework lock-in", desc: "TypeScript, Python and Rust SDKs wrap a single callable." },
  { title: "Open interfaces", desc: "ERC-8004 identity, x402 payments and Rego policies are files you own." },
];

const TIERS = [
  { name: "Free", price: "$0", cadence: "forever", desc: "Evaluate the gate on one agent.", features: ["1 registered agent", "Risk envelope enforcement", "Hash-chained audit trail", "Community support"], cta: "Start free", featured: false },
  { name: "Growth", price: "$200", cadence: "per month", desc: "For teams putting agents in front of customers.", features: ["Unlimited agents", "Avaira Score + credit market", "Insurance pool coverage", "On-chain anchoring", "Priority support"], cta: "Start with Growth", featured: true },
  { name: "Enterprise", price: "$2,000", cadence: "per month", desc: "For regulated deployments and underwriters.", features: ["Dedicated settlement lanes", "Custom Rego policy packs", "SLA + named engineer", "Private deployment"], cta: "Talk to us", featured: false },
];

const FAQ = [
  ["How is this different from prompt-based guardrails?", "Prompts are advisory. AVAIRA places a hard gate between your agent and the action: the risk envelope, the policy engine and the symbolic prover all have to agree before a permit is issued, and the agent never runs execute_fn otherwise."],
  ["Does my agent’s model or framework matter?", "No. You wrap a single callable, so any model that can call a function is compatible — the gate reasons about the intent, not about what generated it."],
  ["What happens when an agent misbehaves?", "Deviation freezes the agent, slashes collateral and compensates the insurance pool within 200ms. Recovery runs through a documented warning → suspension → ban ladder, not a support ticket."],
  ["How is the Avaira Score computed?", "Six Sybil-resistant components driven by settled payments and behavioural history, with Laplace smoothing for small samples. It is deterministic: the same history produces the same score, so it can be recomputed and challenged on-chain."],
  ["Can we self-host it?", "Yes. docker-compose brings up the API, MongoDB, the OPA policy engine and the anchor cron; the SDKs point at your own host. Managed hosting is available when you would rather not run MongoDB yourself."],
  ["Which chains are supported?", "EVM chains. The contract stack ships with Fuji deployment addresses and a Foundry deploy script for any EVM target, plus an ERC-8004 identity interface that keeps the registry portable."],
];

const SDK_CODE = `from avaira import AvairaClient, AvairaConfig, RiskEnvelope

# 1. Define boundaries
envelope = RiskEnvelope(max_spend_usd=50.0, allowed_actions=["search"])
config = AvairaConfig(api_key="your_api_key", risk_envelope=envelope)
avaira = AvairaClient(config)

# 2. Wrap your agent
result = await avaira.run(
    task="Search for YC news",
    execute_fn=lambda: my_agent.run("Search for YC news")
)

print(result["status"]) # 'completed' or 'blocked'`;

const SDK_CALLS = [
  ["register", "Register agent with collateral and risk envelope"],
  ["declareIntent", "Declare mission intent before executing"],
  ["execute", "Execute through AVAIRA’s enforcement layer"],
  ["settle", "Settle mission with 85/10/5 fee split"],
];

const NavLink = ({ href, children }) => (
  <a
    href={href}
    className="hidden text-[13px] font-medium text-avaira-muted transition-colors hover:text-foreground lg:block"
  >
    {children}
  </a>
);

const SectionHead = ({ eyebrow, title, lede, align = "left", id }) => (
  <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
    {eyebrow && <p className="mk-eyebrow mb-3">{eyebrow}</p>}
    <h2 id={id} className={`mk-display ${align === "center" ? "text-3xl sm:text-4xl" : "text-2xl sm:text-3xl"}`}>
      {title}
    </h2>
    {lede && <p className="mk-lede mt-4">{lede}</p>}
  </div>
);

export default function Landing() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const goToProtocol = () => {
    if (user) {
      navigate("/dashboard");
      return;
    }
    navigate("/login?redirect=/dashboard");
  };

  return (
    <div className="theme-marketing min-h-screen bg-avaira-bg text-foreground overflow-x-hidden" data-testid="landing-page">
      {/* ── Nav ───────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 border-b border-avaira-border bg-avaira-bg/85 backdrop-blur-xl">
        <div className="mk-container mk-container-wide flex h-16 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="AVAIRA" className="h-8 w-8 rounded-lg" />
            <span className="text-[15px] font-semibold tracking-tight text-foreground">AVAIRA</span>
          </div>

          <div className="flex items-center gap-7">
            <NavLink href="#pillars">Protocol</NavLink>
            <NavLink href="#execution">Execution</NavLink>
            <NavLink href="#moats">Why it compounds</NavLink>
            <NavLink href="#pricing">Pricing</NavLink>
            <NavLink href="#faq">FAQ</NavLink>
          </div>

          <div className="flex items-center gap-2">
            <button
              data-testid="nav-login-btn"
              onClick={() => navigate("/login")}
              className="mk-btn hidden text-avaira-muted hover:text-foreground sm:inline-flex"
            >
              Sign in
            </button>
            <button
              data-testid="launch-protocol-btn"
              onClick={goToProtocol}
              className="mk-btn mk-btn-primary"
            >
              Launch protocol
              <ChevronRight size={15} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pb-16 pt-20 sm:pt-28" data-testid="hero-section">
        <div className="mk-grid-bg absolute inset-0 -z-20" />
        <div className="mk-glow -z-10 h-[420px] w-[560px] -translate-x-1/2 left-1/2 top-[-160px] mk-glow-violet" />
        <div className="mk-glow -z-10 h-[320px] w-[380px] left-[8%] top-[40px] mk-glow-sky opacity-40" />
        <div className="mk-glow -z-10 h-[300px] w-[360px] right-[6%] top-[10px] mk-glow-rose opacity-35" />

        <div className="mk-container">
          <div className="mx-auto max-w-3xl text-center">
            <span className="mk-pill mx-auto">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-avaira-primary/12 text-avaira-primary">
                <ShieldCheck size={12} strokeWidth={2.4} />
              </span>
              Open standards · ERC-8004 · x402 · EIP-712
            </span>

            <h1 className="mk-display mt-6 text-4xl sm:text-5xl lg:text-6xl">
              The trust layer for{" "}
              <span className="text-avaira-primary">autonomous agents</span>
            </h1>

            <p className="mk-lede mx-auto mt-6 max-w-2xl">
              Rate, clear and insure every agent action before it executes. AVAIRA gives your agents a
              public reputation score, a tamper-evident audit trail, and automatic consequences for bad
              behaviour — enforced, not audited.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                data-testid="hero-launch-btn"
                onClick={goToProtocol}
                className="mk-btn mk-btn-primary mk-btn-lg w-full sm:w-auto"
              >
                Launch the protocol
                <ArrowRight size={16} strokeWidth={2.5} />
              </button>
              <button
                data-testid="hero-login-btn"
                onClick={() => navigate("/login")}
                className="mk-btn mk-btn-secondary mk-btn-lg w-full sm:w-auto"
              >
                <LogIn size={15} />
                Sign in
              </button>
            </div>

            <p className="mt-5 font-mono text-[11px] tracking-[0.14em] text-avaira-dim uppercase">
              &lt;200ms finality · 0.5% protocol fee · AAA–D scoring
            </p>
          </div>

          <div className="relative mx-auto mt-14 max-w-4xl">
            <WindowFrame>
              <MockConsole />
            </WindowFrame>
            <p className="mt-4 text-center text-[13px] text-avaira-muted">
              Every execution passes the gate before it touches capital.
            </p>
          </div>
        </div>
      </section>

      {/* ── Pillars ───────────────────────────────────────────── */}
      <section id="pillars" className="mk-section" data-testid="pillars-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            eyebrow="The protocol"
            title="Three functions. One protocol."
            lede="Rating agencies, clearing houses and insurers exist because capital needs trust. Agents need all three, in the same request path."
          />
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
            {PILLARS.map((p) => (
              <div key={p.title} className="mk-card p-6" data-testid={`pillar-${p.title.toLowerCase()}`}>
                <div
                  className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{ background: "rgb(var(--accent) / 0.10)", color: p.color }}
                >
                  <p.icon size={19} strokeWidth={1.75} />
                </div>
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">{p.title}</h3>
                  <span className="text-[13px] text-avaira-muted">{p.subtitle}</span>
                </div>
                <p className="mt-3 text-[14px] leading-relaxed text-avaira-muted">{p.desc}</p>
                <div className="mt-5 flex items-center justify-between border-t border-avaira-border pt-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-avaira-dim">Comparable</span>
                  <span className="font-mono text-xs" style={{ color: p.color }}>{p.stat}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Execution gate ────────────────────────────────────── */}
      <section id="execution" className="mk-section" data-testid="how-it-works-section">
        <div className="mk-container mk-container-wide">
          <div className="grid items-start gap-12 lg:grid-cols-2">
            <div>
              <SectionHead
                eyebrow="Execution flow"
                title="Nothing executes until the gate says so."
                lede="Six deterministic steps sit between your agent’s intent and the settlement layer. A single disagreement stops the action and starts the consequences."
              />
              <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
                {STEPS.map((s) => (
                  <div
                    key={s.step}
                    className="execution-step-card p-4"
                    data-testid={`step-${s.step}`}
                  >
                    <span className="execution-step-number">{s.step}</span>
                    <p className="mt-2 text-[13px] font-semibold tracking-tight text-foreground">{s.label}</p>
                    <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-avaira-muted">{s.desc}</p>
                  </div>
                ))}
              </div>

              <div className="execution-alert-panel mt-4 p-4">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-avaira-red">
                  <Zap size={14} strokeWidth={2.2} />
                  Deviation detected?
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-avaira-muted">
                  Agent instantly frozen. Collateral slashed. Insurance pool compensates backers. All
                  within 200ms.
                </p>
              </div>
            </div>

            <div className="lg:pt-16">
              <WindowFrame url="app.avaira.xyz/executions">
                <MockGate />
              </WindowFrame>
              <div className="mt-4 grid grid-cols-3 gap-3">
                {[["Prover", "Interval arithmetic"], ["Policy", "OPA Rego"], ["Receipt", "Merkle root"]].map(([k, v]) => (
                  <div key={k} className="mk-card-flat px-3 py-2.5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-avaira-dim">{k}</p>
                    <p className="mt-0.5 text-[12px] text-avaira-muted">{v}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Registry ──────────────────────────────────────────── */}
      <section className="mk-section mk-section-tight">
        <div className="mk-container mk-container-wide grid items-center gap-12 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <WindowFrame url="app.avaira.xyz/agents">
              <MockRegistry />
            </WindowFrame>
          </div>
          <div className="order-1 lg:order-2">
            <SectionHead
              eyebrow="Agent registry"
              title="One screen for every agent you run."
              lede="Scores, risk envelopes, coverage and status — the same objects the contracts enforce, visible before an incident rather than in a post-mortem."
            />
            <ul className="mk-hairline-list mt-8">
              {[
                ["Avaira Score", "Deterministic AAA–D rating grounded in settled payments."],
                ["Risk envelopes", "Spend ceilings and allowed actions per agent, per mission."],
                ["Status control", "Active, paused or frozen — reversible by operators, not by prompts."],
                ["Trust heatmap", "Fourteen days of behaviour at a glance."],
              ].map(([title, desc]) => (
                <li key={title} className="flex gap-3 py-4">
                  <span className="mk-tick mt-0.5"><Check size={11} strokeWidth={3.2} /></span>
                  <div>
                    <p className="text-[14px] font-semibold tracking-tight text-foreground">{title}</p>
                    <p className="mt-0.5 text-[13px] text-avaira-muted">{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Moats ─────────────────────────────────────────────── */}
      <section id="moats" className="mk-section" data-testid="moats-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            eyebrow="Defensibility"
            title="Why it compounds."
            lede="Each settled execution makes the risk models sharper, the scores more accurate, and the network harder to replace."
          />
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
            {MOATS.map((m, i) => (
              <div key={m.title} className="mk-card p-5" data-testid={`moat-${i}`}>
                <m.icon size={18} strokeWidth={1.75} className="mb-4 text-avaira-primary" />
                <h3 className="text-[14px] font-semibold tracking-tight text-foreground">{m.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-avaira-muted">{m.desc}</p>
              </div>
            ))}
          </div>

          {/* Standards + differentiators */}
          <div className="mt-16 grid gap-12 lg:grid-cols-2">
            <div>
              <p className="mk-eyebrow mb-3">Interoperable by default</p>
              <h3 className="mk-display text-xl">Built on standards you already trust.</h3>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {STANDARDS.map((s) => (
                  <div key={s.name} className="mk-card-flat flex items-start gap-3 p-4">
                    <s.icon size={16} strokeWidth={1.75} className="mt-0.5 flex-none text-avaira-primary" />
                    <div>
                      <p className="font-mono text-[12px] text-foreground">{s.name}</p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-avaira-muted">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="mk-eyebrow mb-3">Not another dashboard</p>
              <h3 className="mk-display text-xl">Observability is not enforcement.</h3>
              <div className="mk-hairline-list mt-6">
                {DIFFERENTIATORS.map((d) => (
                  <div key={d.title} className="flex gap-4 py-4">
                    <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-avaira-primary/10 text-avaira-primary">
                      <d.icon size={15} strokeWidth={1.9} />
                    </span>
                    <div>
                      <p className="text-[14px] font-semibold tracking-tight text-foreground">{d.title}</p>
                      <p className="mt-0.5 text-[13px] text-avaira-muted">{d.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Ownership ─────────────────────────────────────────── */}
      <section className="mk-section mk-section-tight">
        <div className="mk-container mk-container-wide">
          <div className="mx-auto max-w-2xl text-center">
            <p className="mk-eyebrow mb-3">No lock-in</p>
            <h2 className="mk-display text-2xl sm:text-3xl">Your agent stays yours.</h2>
            <p className="mk-lede mx-auto mt-4 max-w-xl">
              AVAIRA is infrastructure that sits beside your agent, not a platform your agent has to be
              rewritten for.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {OWNERSHIP.map((o) => (
              <div key={o.title} className="mk-card-block border-l pl-5">
                <p className="text-[14px] font-semibold tracking-tight text-foreground">{o.title}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-avaira-muted">{o.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Revenue ───────────────────────────────────────────── */}
      <section id="revenue" className="mk-section" data-testid="revenue-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            eyebrow="Revenue architecture"
            title="Four revenue streams from day one."
            lede="Every stream is anchored to a settled execution, so growth tracks the volume of authorised work rather than seat count."
          />
          <div className="mk-card mt-10 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Stream</th>
                  <th>Description</th>
                  <th className="text-right">Year 1</th>
                  <th className="text-right">Year 5</th>
                </tr>
              </thead>
              <tbody>
                {REVENUE.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium text-foreground">{r.name}</td>
                    <td>{r.desc}</td>
                    <td className="text-right font-mono text-avaira-yellow">{r.year1}</td>
                    <td className="text-right font-mono text-avaira-green">{r.year5}</td>
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold text-avaira-primary">Total</td>
                  <td />
                  <td className="text-right font-mono font-semibold text-avaira-primary">$4M</td>
                  <td className="text-right font-mono font-semibold text-avaira-primary">$770M</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[13px] text-avaira-muted">
            At a 10× revenue multiple — standard for high-growth SaaS with network effects —{" "}
            <span className="font-medium text-foreground">$7.7B valuation by year five</span>.
          </p>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────── */}
      <section id="pricing" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            align="center"
            eyebrow="Pricing"
            title="Start free. Pay when your agents are in production."
            lede="One price per tier. No per-seat maths, no usage cliff on the gate itself."
          />
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className={`mk-card flex flex-col p-6 ${t.featured ? "border-avaira-primary/45 shadow-mk" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-[15px] font-semibold tracking-tight text-foreground">{t.name}</p>
                  {t.featured && (
                    <span className="rounded-full bg-avaira-primary/12 px-2.5 py-1 text-[11px] font-medium text-avaira-primary">
                      Most popular
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold tracking-tight text-foreground">{t.price}</span>
                  <span className="text-[13px] text-avaira-muted">{t.cadence}</span>
                </div>
                <p className="mt-2 text-[13px] text-avaira-muted">{t.desc}</p>
                <ul className="mt-6 space-y-2.5">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5">
                      <span className="mk-tick mt-0.5"><Check size={11} strokeWidth={3.2} /></span>
                      <span className="text-[13px] text-avaira-muted">{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={goToProtocol}
                  className={`mk-btn mt-7 w-full ${t.featured ? "mk-btn-primary" : "mk-btn-secondary"}`}
                >
                  {t.cta}
                </button>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-[12.5px] text-avaira-muted">
            Testnet deployments are free. Cancel or downgrade at any time — the audit trail stays yours.
          </p>
        </div>
      </section>

      {/* ── SDK ───────────────────────────────────────────────── */}
      <section id="sdk" className="mk-section" data-testid="sdk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            eyebrow="Developer experience"
            title="Four function calls. That’s it."
            lede="If integration takes more than ten minutes, the product has failed."
          />
          <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="mk-window">
              <div className="mk-window-bar">
                <Code size={13} className="text-avaira-primary" />
                <span className="font-mono text-[11px] text-avaira-muted">agent.py</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[12px] leading-relaxed text-avaira-muted">
                {SDK_CODE}
              </pre>
            </div>

            <div className="mk-hairline-list">
              {SDK_CALLS.map(([fn, desc], i) => (
                <div key={fn} className="py-4">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-[11px] text-avaira-dim">0{i + 1}</span>
                    <span className="font-mono text-[13px] text-foreground">.{fn}()</span>
                  </div>
                  <p className="mt-1 pl-8 text-[13px] text-avaira-muted">{desc}</p>
                </div>
              ))}
              <div className="pt-5">
                <a
                  href="https://github.com/ranaalyan1/avaira.xyz"
                  target="_blank"
                  rel="noreferrer"
                  className="mk-btn mk-btn-secondary"
                >
                  <Github size={15} />
                  Read the SDK docs
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────── */}
      <section id="faq" className="mk-section">
        <div className="mk-container">
          <SectionHead align="center" eyebrow="Support" title="Frequently asked questions" />
          <div className="mx-auto mt-10 max-w-3xl">
            {FAQ.map(([q, a]) => (
              <details key={q} className="mk-faq-item">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-t border-avaira-border" data-testid="cta-section">
        <div className="mk-glow -z-10 h-[360px] w-[520px] left-1/2 top-[-120px] -translate-x-1/2 mk-glow-violet" />
        <div className="mk-container py-24 text-center">
          <h2 className="mk-display mx-auto max-w-2xl text-3xl sm:text-4xl">
            Give your agents the trust layer they deserve.
          </h2>
          <p className="mk-lede mx-auto mt-5 max-w-xl">
            Add accountability in three lines of Python. Keep the audit trail, the score and the
            consequences — without rewriting your agent.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button
              data-testid="cta-launch-btn"
              onClick={goToProtocol}
              className="mk-btn mk-btn-primary mk-btn-lg w-full sm:w-auto"
            >
              Launch AVAIRA protocol
              <ArrowRight size={16} strokeWidth={2.5} />
            </button>
            <a
              href="https://github.com/ranaalyan1/avaira.xyz"
              target="_blank"
              rel="noreferrer"
              className="mk-btn mk-btn-secondary mk-btn-lg w-full sm:w-auto"
            >
              <Github size={15} />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="border-t border-avaira-border bg-avaira-surface">
        <div className="mk-container mk-container-wide py-14">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
            <div>
              <div className="flex items-center gap-2.5">
                <img src="/logo.png" alt="AVAIRA" className="h-7 w-7 rounded-md" />
                <span className="text-[14px] font-semibold tracking-tight text-foreground">AVAIRA</span>
              </div>
              <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-avaira-muted">
                Real-time accountability and pre-execution control for autonomous AI agents. Enforcement
                before execution, not audit after damage.
              </p>
              <div className="mt-5 flex items-center gap-2">
                <span className="status-dot active" />
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-avaira-muted">
                  Protocol online
                </span>
              </div>
            </div>

            <div className="mk-footer-col">
              <h4>Protocol</h4>
              <a href="#pillars">Rate</a>
              <a href="#pillars">Clear</a>
              <a href="#pillars">Insure</a>
              <a href="#execution">Execution flow</a>
              <a href="#revenue">Revenue</a>
            </div>

            <div className="mk-footer-col">
              <h4>Developers</h4>
              <a href="#sdk">SDK reference</a>
              <a href="/sdk">Console docs</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/contracts" target="_blank" rel="noreferrer">Contracts</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/verification" target="_blank" rel="noreferrer">Verification reports</a>
            </div>

            <div className="mk-footer-col">
              <h4>Company</h4>
              <a href="#pricing">Pricing</a>
              <a href="#faq">FAQ</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/SECURITY.md" target="_blank" rel="noreferrer">Security</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Changelog</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/LICENSE" target="_blank" rel="noreferrer">License</a>
            </div>
          </div>

          <div className="mt-12 flex flex-col gap-3 border-t border-avaira-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-mono text-[11px] text-avaira-dim">
              © {new Date().getFullYear()} AVAIRA. All rights reserved.
            </p>
            <p className="font-mono text-[11px] text-avaira-dim">
              Execution control protocol · v2.0-core
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
