import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { ArrowUpRight, Github } from "lucide-react";
import { useAuth } from "@/App";
import { useReveal } from "@/lib/motion";
import {
  ConsoleActions,
  Glyph,
  PageHead,
  PixelFooter,
  PixelNav,
  SectionIndex,
  SpecRows,
} from "@/components/marketing/pixel";

/* Integration. The snippets are the ones the repository ships; the envelope
 * fields are the fields the gate actually reads. */

const TS_SNIPPET = `import { Avaira, loadDeployment } from "@avaira/sdk";

const deployment = loadDeployment(46630);           // Robinhood Testnet

const avaira = new Avaira({
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  privateKey: process.env.AGENT_PRIVATE_KEY,
  contracts: deployment,
});

// The callback only runs when the gate returns a signed permit.
const result = await avaira.run(
  1n,                                               // ERC-8004 agentId
  { task: "reconcile-invoice", invoiceId: "INV-4821" },
  async ({ audit }) => {
    return reconcile("INV-4821", { onStep: audit });
  },
);

console.log(result.status);                         // "completed" | "blocked"`;

const PY_SNIPPET = `from avaira import AvairaClient, AvairaConfig, RiskEnvelope

envelope = RiskEnvelope(max_spend_usd=50.0, allowed_actions=["search"])
avaira = AvairaClient(AvairaConfig(api_key="...", risk_envelope=envelope))

# execute_fn is only reached when the gate returns a signed permit
result = await avaira.run(
    task="Search for YC news",
    execute_fn=lambda: my_agent.run("Search for YC news"),
)

print(result["status"])   # "completed" or "blocked"`;

const FRAMEWORK_SNIPPET = `from avaira_shield import AvairaClient, protect_agent, protect_crew

client = AvairaClient(api_key="avk_live_...", agent_id="agent-alpha")

protected_executor = protect_agent(langchain_executor, client)  # wraps every tool
protected_crew     = protect_crew(crewai_instance, client)      # wraps every agent`;

const ENVELOPE = [
  ["max_spend_usd", "ceiling for a single intent; the value the prover checks against"],
  ["allowed_actions", "the action classes this agent may commit; anything else is refused at policy"],
  ["envelope hash", "the committed digest of the two above, stored before execution"],
  ["deadline", "the point past which the intent returns INTENT_EXPIRED"],
  ["agent id", "ERC-8004 identity; the registry holds the bond and the status"],
];

const STANDARDS = [
  ["ERC-8004", "bonded agent identity and on-chain status"],
  ["EIP-712", "typed, signed, single-use execution permits"],
  ["EIP-3009", "USDC proof-of-payment without an approval step"],
  ["OPA Rego", "policies as versioned, testable files"],
  ["EVM", "Fuji addresses, Robinhood deployment script"],
];

const SURFACES = [
  ["SDKs", "TypeScript, Python and Rust, plus LangChain and CrewAI wrappers"],
  ["Console", "the operator views: registry, executions, freeze, treasury, reputation, underwriters"],
  ["Reference", "the SDK docs view inside the console, served from the app"],
  ["Self-hosting", "API, policy engine, database and the anchoring job from the compose file"],
];

export default function DocsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const reveal = useReveal({ step: 60 });

  const goToConsole = () => {
    if (user) {
      navigate("/dashboard");
      return;
    }
    navigate("/login?redirect=/dashboard");
  };

  return (
    <div className="px-site" ref={reveal}>
      <PixelNav onLaunch={goToConsole} onSignIn={() => navigate("/login")} />

      <PageHead
        n="05"
        section="Integration"
        title="One call around the function that spends."
        lede="The integration point is the callable, not the model. Wrap the function that performs the action and the gate handles the envelope, the policy check, the permit and the audit entry."
        meta={
          <>
            <span>TypeScript</span>
            <span data-sep>/</span>
            <span>Python</span>
            <span data-sep>/</span>
            <span>Rust</span>
            <span data-sep>/</span>
            <span>LangChain + CrewAI</span>
          </>
        }
      />

      <section className="px-section px-section-flat" id="sdk" data-testid="sdk-section">
        <div className="px-wrap">
          <SectionIndex n="05.1" label="Wrap the call" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "26ch" }} data-reveal>
            The callback decides nothing. The gate does.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            Declare the envelope once, then hand the agent's action to the SDK. If the gate refuses, the
            callback never runs and the result carries the refusal code instead.
          </p>

          <div className="px-grid-2" style={{ marginTop: "2.5rem" }}>
            <div className="mk-window" data-reveal>
              <div className="mk-window-bar">
                <Glyph seed="TS" size={13} />
                <span className="mk-window-title">agent.ts</span>
              </div>
              <pre className="mk-code">{TS_SNIPPET}</pre>
            </div>

            <div className="mk-window" data-reveal>
              <div className="mk-window-bar">
                <Glyph seed="PY" size={13} />
                <span className="mk-window-title">agent.py</span>
              </div>
              <pre className="mk-code">{PY_SNIPPET}</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="px-section">
        <div className="px-wrap">
          <SectionIndex n="05.2" label="Frameworks" />
          <div className="px-split" style={{ marginTop: "2rem" }}>
            <div>
              <h2 className="px-dot px-h2" style={{ maxWidth: "22ch" }} data-reveal>
                Two lines for LangChain and CrewAI.
              </h2>
              <p className="px-body" style={{ marginTop: "1rem", maxWidth: "48ch" }} data-reveal>
                The wrappers intercept tool and agent calls and route them through the same gate, so a
                framework integration does not need its own policy path.
              </p>
              <SpecRows title="Envelope" rows={ENVELOPE} />
            </div>

            <div className="mk-window" data-reveal>
              <div className="mk-window-bar">
                <Glyph seed="SHIELD" size={13} />
                <span className="mk-window-title">shield.py</span>
              </div>
              <pre className="mk-code">{FRAMEWORK_SNIPPET}</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="px-section">
        <div className="px-wrap">
          <SectionIndex n="05.3" label="Standards and surfaces" />
          <div className="px-split" style={{ marginTop: "2rem" }}>
            <SpecRows title="Standards" rows={STANDARDS} />
            <SpecRows title="Where to go next" rows={SURFACES} />
          </div>

          <div className="px-hero-actions" style={{ marginTop: "2.5rem" }}>
            <a className="px-btn px-btn-accent" href="https://github.com/ranaalyan1/avaira.xyz" target="_blank" rel="noreferrer">
              <Github size={14} strokeWidth={2} />
              Read the source
            </a>
            <Link className="px-btn" to="/sdk">
              Console SDK reference
              <ArrowUpRight size={14} strokeWidth={2} />
            </Link>
            <Link className="px-btn px-btn-quiet" to="/evidence">
              Verification numbers
            </Link>
          </div>

          <ConsoleActions onLaunch={goToConsole} />
        </div>
      </section>

      <PixelFooter />
    </div>
  );
}
