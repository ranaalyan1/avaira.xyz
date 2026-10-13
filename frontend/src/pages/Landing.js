import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Ban,
  Boxes,
  Check,
  Code,
  FileKey,
  Fingerprint,
  Gavel,
  Github,
  Heart,
  Lock,
  LogIn,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/App";
import { usePointerTilt, useReveal } from "@/lib/motion";
import GateTrace from "@/components/marketing/GateTrace";
import GatePipeline from "@/components/marketing/GatePipeline";
import {
  EvidenceTable,
  PenaltyLadder,
  RefusalTable,
  ScoreLadder,
  ScoreWeights,
} from "@/components/marketing/SpecBlocks";

/* Every claim on this page is traceable to a file in the repository: the enum
 * and the state machine in contracts/src/interfaces/IAvaira.sol, the formula in
 * backend/core/reputation.py, the measured figures in contracts/metrics and
 * verification/reports. There is no projection standing in for a fact. */

const PILLARS = [
  {
    icon: TrendingUp,
    id: "pillar-rate",
    term: "Rate",
    subtitle: "Avaira Score, recomputable by anyone",
    body: "Six weighted inputs decide what an agent may attempt and how much collateral it posts. The formula is public, so two operators reading the same settled history reach the same grade.",
  },
  {
    icon: FileKey,
    id: "pillar-clear",
    term: "Clear",
    subtitle: "Committed before, attested after",
    body: "The envelope is hashed and committed before the action is attempted, then the outcome is attested against it. The protocol keeps its own record of what was authorised and what actually ran.",
  },
  {
    icon: Heart,
    id: "pillar-insure",
    term: "Insure",
    subtitle: "Underwriters stake against missions",
    body: "Backers take a position on a mission. A failed mission pays them from slashed collateral on the 85, 10 and 5 split; a mission that settles returns principal plus its share of the fee.",
  },
];

const STEPS = [
  { id: "step-01", term: "Envelope", body: "The agent declares a spend ceiling and the actions it is allowed to take." },
  { id: "step-02", term: "Commitment", body: "That envelope is hashed and committed before the action is attempted." },
  { id: "step-03", term: "Policy", body: "A versioned Rego file decides whether this class of action is allowed at all." },
  { id: "step-04", term: "Prover", body: "Interval arithmetic checks the intent against hard invariants and returns a witness when it fails." },
  { id: "step-05", term: "Permit", body: "An EIP-712 signature is issued for this intent, this agent and this deadline, and for nothing else." },
  { id: "step-06", term: "Settlement", body: "The outcome is attested, the fee is split and the score is updated from the result." },
];

const MOATS = [
  {
    icon: Lock,
    term: "Committed before execution",
    body: "An intent that was never committed cannot be executed, so there is no window in which an agent can act first and explain later.",
  },
  {
    icon: Ban,
    term: "Single-use permissions",
    body: "A permit is bound to one intent hash and burns on use. Replaying an approved intent against a second target returns INTENT_ALREADY_EXECUTED.",
  },
  {
    icon: Gavel,
    term: "Witnesses, not verdicts",
    body: "When the prover refuses, it returns the interval that broke the invariant. A refusal is evidence a counterparty can read, not a status message.",
  },
  {
    icon: ShieldCheck,
    term: "Score attached to collateral",
    body: "The rating only carries weight because it moves real money: grades set collateral ratios, and a slash moves the grade down.",
  },
  {
    icon: Boxes,
    term: "Blast radius contained",
    body: "The gate is a callable wrapper, not a model hook. It reasons about the intent, the target and the value, so the worst case is one refused call.",
  },
];

/* The four fee streams the protocol actually settles (Treasury.js tracks the
 * same four). Year-one and year-five columns are the plan, stated as a plan. */
const REVENUE = [
  { name: "Registration", desc: "Free, Growth at $200/mo, Enterprise at $2,000/mo. Not metered by intent or agent.", year1: "$1.2M", year5: "$240M" },
  { name: "Underwriting spread", desc: "5% of every settled mission, paid by the agent's envelope, split across the backers.", year1: "$2M", year5: "$400M" },
  { name: "Slashing share", desc: "20% of slashed collateral reaches the treasury; the rest compensates the pool.", year1: "$500K", year5: "$50M" },
  { name: "Data and scores", desc: "Per-query access to scores, refusal history and settlement records.", year1: "$300K", year5: "$80M" },
];

const STANDARDS = [
  { icon: Fingerprint, name: "ERC-8004", desc: "Bonded agent identity and on-chain status" },
  { icon: Wallet, name: "EIP-3009 USDC", desc: "Proof-of-payment without an approval step" },
  { icon: ScrollText, name: "EIP-712", desc: "Typed, signed, single-use execution permits" },
  { icon: Gavel, name: "OPA Rego", desc: "Policies as versioned, testable files" },
  { icon: Boxes, name: "EVM chains", desc: "Fuji addresses, Monad deploy script" },
  { icon: ShieldCheck, name: "TEE attestation", desc: "Execution image digests verified, not assumed" },
];

const PRICING = [
  {
    name: "Free",
    price: "$0",
    cadence: "no card",
    body: "One agent, testnet only, to see whether the gate reasons the way you expect.",
    lines: ["One registered agent", "Envelope and policy enforcement", "Hash-chained audit trail", "Community support"],
    featured: false,
    cta: "Start here",
  },
  {
    name: "Growth",
    price: "$200",
    cadence: "per month",
    body: "For teams running agents against real budgets.",
    lines: [
      "Unlimited agents",
      "Avaira Score and credit market",
      "Underwriting coverage",
      "Anchor roots on chain",
      "Support with a response target",
    ],
    featured: true,
    cta: "Start here",
  },
  {
    name: "Enterprise",
    price: "$2,000",
    cadence: "per month",
    body: "For regulated deployments and underwriting desks.",
    lines: ["Dedicated settlement lanes", "Custom policy packs", "Private deployment", "Named engineer, written SLA"],
    featured: false,
    cta: "Talk to us",
  },
];

const FAQ = [
  {
    q: "How is this different from logging what an agent did?",
    a: "Logging answers the question after the money has moved. The gate runs before it: the envelope, the policy file and the prover all have to agree, and without a signed permit the function that spends is never entered. The audit trail is a byproduct, not the control.",
  },
  {
    q: "Does it care which model or framework the agent uses?",
    a: "No. You wrap the callable that performs the action. The gate reasons about the intent, its target and its value, so any model that can call a function is compatible.",
  },
  {
    q: "What happens when an agent deviates from its envelope?",
    a: "The intent is refused with a reason code and enforcement follows the documented ladder: a recorded warning, then suspension with slashed collateral and a 24 hour cooldown before re-collateralisation, then a terminal ban. Underwriters are paid from the slashed bond.",
  },
  {
    q: "How is the Avaira Score computed, and can we verify it?",
    a: "Six weighted inputs, published as a formula in the repository: success rate, intent alignment, slash history, economic volume, time on network and appeal resolution. It is deterministic, so the same history always yields the same score and the result can be recomputed and challenged on chain.",
  },
  {
    q: "Which chains does it support?",
    a: "EVM chains. The contract set has addresses on Fuji and a Foundry deployment script for any EVM target, and identity follows ERC-8004 so the registry stays portable.",
  },
  {
    q: "Can we self-host the whole thing?",
    a: "Yes. The API, the policy engine, the database and the anchoring job come up from the compose file in this repository, and the SDKs point at your own host. Managed hosting exists for teams that would rather not run MongoDB.",
  },
  {
    q: "What does the gate cost per check?",
    a: "Nothing. Pricing is per tier, never per intent or per seat, so widening an envelope or adding an agent does not change the bill.",
  },
];

const SDK_SNIPPET = `from avaira import AvairaClient, AvairaConfig, RiskEnvelope

envelope = RiskEnvelope(max_spend_usd=50.0, allowed_actions=["search"])
avaira = AvairaClient(AvairaConfig(api_key="...", risk_envelope=envelope))

# execute_fn is only reached when the gate returns a signed permit
result = await avaira.run(
    task="Search for YC news",
    execute_fn=lambda: my_agent.run("Search for YC news"),
)

print(result["status"])   # "completed" or "blocked"`;

const NavLink = ({ href, children }) => (
  <a href={href} className="mk-nav-link">
    {children}
  </a>
);

const SectionHead = ({ label, title, lede, children }) => (
  <header className="mk-section-head">
    <p className="mk-margin-label" data-reveal>
      {label}
    </p>
    <div className="mk-section-heading">
      <h2 className="mk-display mk-h2" data-reveal>
        {title}
      </h2>
      {lede ? (
        <p className="mk-lede mk-lede-narrow" data-reveal>
          {lede}
        </p>
      ) : null}
      {children}
    </div>
  </header>
);

export default function Landing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const reveal = useReveal({ step: 60 });
  const heroTilt = usePointerTilt({ max: 4.5 });
  const navRef = useRef(null);

  // Scroll progress for the hairline under the navigation. Written to a CSS
  // variable so the browser only repaints one element.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      nav.style.setProperty("--progress", progress.toFixed(4));
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const goToConsole = () => {
    if (user) {
      navigate("/dashboard");
      return;
    }
    navigate("/login?redirect=/dashboard");
  };

  return (
    <div className="theme-marketing min-h-screen bg-avaira-bg text-foreground" data-testid="landing-page" ref={reveal}>
      {/* ── navigation ─────────────────────────────────────────── */}
      <nav className="mk-nav" ref={navRef}>
        <div className="mk-container mk-container-wide mk-nav-inner">
          <a className="mk-brand" href="#top">
            <img src="/logo.png" alt="AVAIRA" className="mk-brand-mark" />
            <span className="mk-brand-name">AVAIRA</span>
          </a>

          <div className="mk-nav-links">
            <NavLink href="#pillars">Pillars</NavLink>
            <NavLink href="#execution">Gate</NavLink>
            <NavLink href="#moats">Refusals</NavLink>
            <NavLink href="#revenue">Revenue</NavLink>
            <NavLink href="#pricing">Pricing</NavLink>
          </div>

          <div className="mk-nav-actions">
            <button data-testid="nav-login-btn" onClick={() => navigate("/login")} className="mk-btn mk-btn-quiet">
              Sign in
            </button>
            <button data-testid="launch-protocol-btn" onClick={goToConsole} className="mk-btn mk-btn-primary">
              Open the console
            </button>
          </div>
        </div>
        <span className="mk-nav-progress" aria-hidden="true" />
      </nav>

      {/* ── hero ───────────────────────────────────────────────── */}
      <header id="top" className="mk-hero" data-testid="hero-section">
        <div className="mk-grid-bg" aria-hidden="true" />
        <div className="mk-glow mk-glow-violet mk-hero-glow-a" aria-hidden="true" />
        <div className="mk-glow mk-glow-sky mk-hero-glow-b" aria-hidden="true" />

        <div className="mk-container mk-container-wide">
          <div className="mk-hero-copy">
            <p className="mk-eyebrow">Execution control for agents that hold budgets</p>

            <h1 className="mk-display mk-hero-title">
              Nothing spends until the gate says yes.
            </h1>

            <p className="mk-lede mk-hero-lede">
              AVAIRA sits between an agent and the action it wants to take. The intent is checked
              against a risk envelope, a policy file and a symbolic prover. All three have to agree
              before a signed permit exists, and that permit is the only thing that lets the action run.
            </p>

            <div className="mk-hero-actions">
              <button data-testid="hero-launch-btn" onClick={goToConsole} className="mk-btn mk-btn-primary mk-btn-lg">
                Open the console
                <ArrowRight size={16} strokeWidth={2.25} />
              </button>
              <button
                data-testid="hero-login-btn"
                onClick={() => navigate("/login")}
                className="mk-btn mk-btn-secondary mk-btn-lg"
              >
                <LogIn size={15} />
                Sign in
              </button>
            </div>

            <dl className="mk-hero-facts">
              <div>
                <dt>Core contracts</dt>
                <dd>6</dd>
              </div>
              <div>
                <dt>Foundry tests</dt>
                <dd>123</dd>
              </div>
              <div>
                <dt>Core coverage</dt>
                <dd>94.4%</dd>
              </div>
              <div>
                <dt>Refusal codes</dt>
                <dd>9</dd>
              </div>
            </dl>
          </div>

          <div className="mk-hero-art" ref={heroTilt}>
            <GateTrace />
            <p className="mk-hero-art-caption">
              Two intents against the same gate. The refused one never reaches the prover, and the
              function that spends is never entered.
            </p>
          </div>
        </div>
      </header>

      {/* ── pillars ────────────────────────────────────────────── */}
      <section id="pillars" className="mk-section" data-testid="pillars-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Pillars"
            title="Rating, clearing and underwriting in one request path."
            lede="Capital markets spread these three functions across three institutions. An agent needs all three at the moment it acts, which is why they live inside the same gate."
          />
          <div className="mk-pillars">
            {PILLARS.map(({ icon: Icon, id, term, subtitle, body }) => (
              <article className="mk-pillar" data-testid={id} data-reveal key={term}>
                <span className="mk-pillar-icon">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <h3 className="mk-pillar-term">{term}</h3>
                <p className="mk-pillar-subtitle">{subtitle}</p>
                <p className="mk-pillar-body">{body}</p>
              </article>
            ))}
          </div>
          <p className="mk-note" data-reveal>
            Sources: contracts/src/{'{Identity,Stake,Reputation}Registry.sol'}, backend/core/reputation.py
          </p>
        </div>
      </section>

      {/* ── the gate, in three dimensions ──────────────────────── */}
      <section id="execution" className="mk-section mk-section-gate" data-testid="how-it-works-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Gate"
            title="Four planes, passed in order, before any money moves."
            lede="Scroll and the intent travels the corridor: envelope, policy, prover, permit. The second corridor carries the same shape of intent with a value the envelope never allowed, and it stops at the policy plane."
          />

          <div className="mk-pipelines">
            <GatePipeline variant="permit" testid="gate-pipeline-permit" />
            <GatePipeline variant="refuse" testid="gate-pipeline-refuse" />
          </div>

          <ol className="mk-steps">
            {STEPS.map(({ id, term, body }) => (
              <li className="mk-step" data-testid={id} data-reveal key={term}>
                <h3 className="mk-step-term">{term}</h3>
                <p className="mk-step-body">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── refusals ───────────────────────────────────────────── */}
      <section id="moats" className="mk-section" data-testid="moats-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Refusals"
            title="Nine ways the gate says no, and one way it says yes."
            lede="A refusal is a value, not an outage. Every blocked intent carries the code for why, which makes the reason machine-readable for the agent, the operator and the underwriter at the same time."
          />

          <div className="mk-split">
            <RefusalTable />
            <div className="mk-moats">
              {MOATS.map(({ icon: Icon, term, body }, index) => (
                <article className="mk-moat" data-testid={`moat-${index}`} data-reveal key={term}>
                  <span className="mk-moat-icon">
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <h3 className="mk-moat-term">{term}</h3>
                  <p className="mk-moat-body">{body}</p>
                </article>
              ))}
            </div>
          </div>

          <p className="mk-note" data-reveal>
            Source: the GateReason enum in contracts/src/interfaces/IAvaira.sol
          </p>
        </div>
      </section>

      {/* ── evidence ───────────────────────────────────────────── */}
      <section id="evidence" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Evidence"
            title="What is measured, and where to check it."
            lede="These figures come out of the test and verification runs committed with the contracts, regenerated by the make targets in the repository rather than copied into a slide."
          />
          <EvidenceTable />
          <a
            className="mk-link"
            href="https://github.com/ranaalyan1/avaira.xyz/tree/main/verification"
            target="_blank"
            rel="noreferrer"
            data-reveal
          >
            Read the verification reports
            <ArrowRight size={14} strokeWidth={2.25} />
          </a>
        </div>
      </section>

      {/* ── score ──────────────────────────────────────────────── */}
      <section id="score" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Score"
            title="One number, six inputs, no discretion."
            lede="The score decides what an agent may attempt and how much collateral it has to post. It is arithmetic over settled outcomes, so two operators reading the same history get the same grade."
          />
          <ScoreWeights />
          <ScoreLadder />
        </div>
      </section>

      {/* ── penalties ──────────────────────────────────────────── */}
      <section id="penalty" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Penalty"
            title="What happens after a deviation."
            lede="Enforcement is a state machine. Each step says what changes, how long it lasts and what it takes to come back, and every transition is recorded with its reason code and the block it happened in."
          />
          <PenaltyLadder />
        </div>
      </section>

      {/* ── revenue ────────────────────────────────────────────── */}
      <section id="revenue" className="mk-section" data-testid="revenue-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Revenue"
            title="Four fee streams, all of them from settled activity."
            lede="The protocol earns when a mission settles or when collateral is slashed, never for sitting in the path. Year five of the plan sums to $770M against $4M in year one."
          />
          <div className="mk-table">
            <div className="mk-table-row mk-table-head">
              <span>stream</span>
              <span>how it is charged</span>
              <span>year 1</span>
              <span>year 5</span>
            </div>
            {REVENUE.map((row) => (
              <div className="mk-table-row" data-reveal key={row.name}>
                <span className="mk-table-name">{row.name}</span>
                <span className="mk-table-desc">{row.desc}</span>
                <span className="mk-table-figure">{row.year1}</span>
                <span className="mk-table-figure mk-table-figure-strong">{row.year5}</span>
              </div>
            ))}
            <div className="mk-table-row mk-table-total">
              <span className="mk-table-name">Total</span>
              <span className="mk-table-desc">Projection from the plan, not a forecast of demand.</span>
              <span className="mk-table-figure">$4M</span>
              <span className="mk-table-figure mk-table-figure-strong">$770M</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── integration ────────────────────────────────────────── */}
      <section id="sdk" className="mk-section" data-testid="sdk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Integration"
            title="One call around the function that spends."
            lede="The integration point is the callable, not the model. Wrap the function that performs the action and the gate handles the envelope, the policy check, the permit and the audit entry."
          />

          <div className="mk-split mk-split-code">
            <div className="mk-window">
              <div className="mk-window-bar">
                <Code size={13} strokeWidth={2} />
                <span className="mk-window-title">agent.py</span>
              </div>
              <pre className="mk-code">{SDK_SNIPPET}</pre>
            </div>

            <div className="mk-standards">
              {STANDARDS.map(({ icon: Icon, name, desc }) => (
                <div className="mk-standard" data-reveal key={name}>
                  <span className="mk-standard-icon">
                    <Icon size={15} strokeWidth={1.75} />
                  </span>
                  <span className="mk-standard-name">{name}</span>
                  <span className="mk-standard-desc">{desc}</span>
                </div>
              ))}
              <div className="mk-actions">
                <button className="mk-btn mk-btn-primary" onClick={goToConsole}>
                  Try it in the console
                </button>
                <a
                  className="mk-btn mk-btn-secondary"
                  href="https://github.com/ranaalyan1/avaira.xyz"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Github size={15} />
                  Read the source
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── pricing ────────────────────────────────────────────── */}
      <section id="pricing" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead
            label="Pricing"
            title="Three tiers. The gate is not metered."
            lede="Adding agents or widening an envelope does not change the bill. Testnet deployments are free, and the audit trail stays yours if you stop paying."
          />
          <div className="mk-tiers">
            {PRICING.map((tier) => (
              <article className={`mk-tier${tier.featured ? " is-featured" : ""}`} data-reveal key={tier.name}>
                <header className="mk-tier-head">
                  <span className="mk-tier-name">{tier.name}</span>
                  <span className="mk-tier-amount">
                    {tier.price}
                    <span className="mk-tier-cadence">{tier.cadence}</span>
                  </span>
                </header>
                <p className="mk-tier-body">{tier.body}</p>
                <ul className="mk-tier-lines">
                  {tier.lines.map((line) => (
                    <li key={line}>
                      <Check size={13} strokeWidth={2.5} />
                      {line}
                    </li>
                  ))}
                </ul>
                <button className={`mk-btn ${tier.featured ? "mk-btn-primary" : "mk-btn-secondary"}`} onClick={goToConsole}>
                  {tier.cta}
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── questions ──────────────────────────────────────────── */}
      <section id="faq" className="mk-section">
        <div className="mk-container mk-container-wide">
          <SectionHead label="Questions" title="Asked often enough to answer here." />
          <div className="mk-faq">
            {FAQ.map(({ q, a }) => (
              <details className="mk-faq-item" data-reveal key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── close ──────────────────────────────────────────────── */}
      <section className="mk-close" data-testid="cta-section">
        <div className="mk-glow mk-glow-violet mk-close-glow" aria-hidden="true" />
        <div className="mk-container mk-container-wide mk-close-inner">
          <h2 className="mk-display mk-close-title">Put a gate in front of the money.</h2>
          <p className="mk-lede mk-close-lede">
            Register an agent, declare an envelope and watch the first intent go through. The console
            shows every check, every refusal and every settlement as it happens.
          </p>
          <div className="mk-hero-actions">
            <button data-testid="cta-launch-btn" onClick={goToConsole} className="mk-btn mk-btn-primary mk-btn-lg">
              Open the console
              <ArrowRight size={16} strokeWidth={2.25} />
            </button>
            <a
              className="mk-btn mk-btn-secondary mk-btn-lg"
              href="https://github.com/ranaalyan1/avaira.xyz"
              target="_blank"
              rel="noreferrer"
            >
              <Github size={15} />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── footer ─────────────────────────────────────────────── */}
      <footer className="mk-footer">
        <div className="mk-container mk-container-wide">
          <div className="mk-footer-grid">
            <div className="mk-footer-brand">
              <div className="mk-brand">
                <img src="/logo.png" alt="AVAIRA" className="mk-brand-mark" />
                <span className="mk-brand-name">AVAIRA</span>
              </div>
              <p className="mk-footer-blurb">
                Pre-execution control for autonomous agents. Enforcement runs before the action, not
                after the incident.
              </p>
              <div className="mk-footer-status">
                <span className="status-dot active" />
                <span>Protocol online</span>
              </div>
            </div>

            <nav className="mk-footer-col">
              <h4>Protocol</h4>
              <a href="#pillars">Pillars</a>
              <a href="#execution">Gate</a>
              <a href="#moats">Refusals</a>
              <a href="#score">Score</a>
              <a href="#penalty">Penalty</a>
            </nav>

            <nav className="mk-footer-col">
              <h4>Build</h4>
              <a href="#sdk">Integration</a>
              <a href="/sdk">Console docs</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz" target="_blank" rel="noreferrer">
                Source
              </a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/contracts" target="_blank" rel="noreferrer">
                Contracts
              </a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/verification" target="_blank" rel="noreferrer">
                Verification
              </a>
            </nav>

            <nav className="mk-footer-col">
              <h4>Company</h4>
              <a href="#pricing">Pricing</a>
              <a href="#revenue">Revenue</a>
              <a href="#faq">Questions</a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
                Security
              </a>
              <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/LICENSE" target="_blank" rel="noreferrer">
                License
              </a>
            </nav>
          </div>

          <div className="mk-footer-base">
            <span>{new Date().getFullYear()} AVAIRA</span>
            <span>Execution control protocol</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
