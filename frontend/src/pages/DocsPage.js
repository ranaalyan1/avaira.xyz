import { useReveal } from "@/lib/motion";
import { ImmersiveNav, ImmersiveFoot, usePageTitle } from "@/pages/immersive/shell";

/* Integration, in the immersive language. The snippets are the ones the
 * repository ships; the envelope fields are the fields the gate actually
 * reads. */

const TS_SNIPPET = [
  ['import { Avaira, loadDeployment } from "@avaira/sdk";'],
  ["const deployment = loadDeployment(4663);            // Robinhood Mainnet"],
  ["const avaira = new Avaira({ chainId: 46630, rpcUrl: \"https://rpc.testnet.chain.robinhood.com\", privateKey: process.env.AGENT_PRIVATE_KEY, contracts: deployment });"],
  ["// The callback only runs when the gate returns a signed permit."],
  ["const result = await avaira.run("],
  ["  1n,                                               // ERC-8004 agentId"],
  ['  { task: "reconcile-invoice", invoiceId: "INV-4821" },'],
  ["  async ({ audit }) => { return reconcile(\"INV-4821\", { onStep: audit }); },"],
  [");"],
  ['console.log(result.status);                         // "completed" | "blocked"'],
];

const PY_SNIPPET = [
  ["from avaira import AvairaClient, AvairaConfig, RiskEnvelope"],
  ["envelope = RiskEnvelope(max_spend_usd=50.0, allowed_actions=[\"search\"])"],
  ['avaira = AvairaClient(AvairaConfig(api_key="...", risk_envelope=envelope))'],
  ["# execute_fn is only reached when the gate returns a signed permit"],
  ["result = await avaira.run("],
  ['    task="Search for YC news",'],
  ['    execute_fn=lambda: my_agent.run("Search for YC news"),'],
  [")"],
  ['print(result["status"])   # "completed" or "blocked"'],
];

const FRAMEWORK_SNIPPET = [
  ["from avaira_shield import AvairaClient, protect_agent, protect_crew"],
  ['client = AvairaClient(api_key="avk_live_...", agent_id="agent-alpha")'],
  ["protected_executor = protect_agent(langchain_executor, client)  // wraps every tool"],  // py comment → use #
  ["protected_crew     = protect_crew(crewai_instance, client)      # wraps every agent"],
];

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

function Window({ title, lines, testid }) {
  return (
    <div className="imm-window" data-testid={testid} data-reveal>
      <div className="imm-window-bar">
        <i /><i /><i />
        <span>{title}</span>
      </div>
      <pre>
        {lines.map((l, i) => (
          <span key={i}>
            {l[0]}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

export default function DocsPage() {
  const revealRoot = useReveal();
  usePageTitle("Docs and SDK — AVAIRA");

  return (
    <div className="landing-immersive" data-testid="docs-page" ref={revealRoot}>
      <ImmersiveNav />

      <header className="imm-pagehead" id="top">
        <p className="imm-label">05 <em>— integration</em></p>
        <h1 data-reveal>One call around the function that spends.</h1>
        <p className="imm-lead" data-reveal>
          The integration point is the callable, not the model. Wrap the
          function that performs the action and the gate handles the envelope,
          the policy check, the permit and the audit entry.
        </p>
        <ul className="imm-meta">
          <li>typescript</li>
          <li>python</li>
          <li>rust</li>
          <li>langchain + crewai</li>
        </ul>
      </header>

      <main className="imm-page">
        {/* ── sdk ─────────────────────────────────────────────── */}
        <section className="imm-act" id="sdk" data-testid="sdk-section" aria-labelledby="docs-sdk-h">
          <div className="imm-act-head">
            <p className="imm-label">05.1 <em>— wrap the call</em></p>
            <h2 className="imm-h2" id="docs-sdk-h" data-reveal>
              The callback decides nothing. The gate does.
            </h2>
            <p className="imm-lead" data-reveal>
              Declare the envelope once, then hand the agent's action to the
              SDK. If the gate refuses, the callback never runs and the result
              carries the refusal code instead.
            </p>
          </div>

          <div className="imm-tracegrid">
            <Window title="@avaira/sdk — typescript" lines={TS_SNIPPET} testid="docs-ts-window" />
            <Window title="avaira — python" lines={PY_SNIPPET} testid="docs-py-window" />
          </div>

          <div className="imm-specgrid" style={{ marginTop: "2.4rem" }}>
            {ENVELOPE.map(([term, body]) => (
              <div className="imm-spec" key={term}>
                <h4>{term}</h4>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── frameworks ──────────────────────────────────────── */}
        <section className="imm-act" id="frameworks" aria-labelledby="docs-frameworks-h">
          <div className="imm-act-head">
            <p className="imm-label">05.2 <em>— frameworks</em></p>
            <h2 className="imm-h2" id="docs-frameworks-h" data-reveal>
              Shields for LangChain and CrewAI.
            </h2>
          </div>

          <div className="imm-tracegrid">
            <Window title="avaira_shield" lines={FRAMEWORK_SNIPPET} testid="docs-framework-window" />
            <div className="imm-verdict imm-trace" data-reveal>
              <div className="imm-trace-head">
                <strong>What gets wrapped</strong>
              </div>
              <p className="imm-body" style={{ fontSize: "0.85rem" }}>
                <code>protect_agent</code> wraps every tool call a LangChain
                executor makes; <code>protect_crew</code> wraps every agent in
                a CrewAI instance. Spend attempts outside the envelope return
                the refusal code to the framework instead of executing.
              </p>
              <p className="imm-trace-verdict" style={{ color: "var(--imm-lime)" }}>
                EIP-712 permit or a named refusal — nothing in between
              </p>
            </div>
          </div>
        </section>

        {/* ── standards and surfaces ──────────────────────────── */}
        <section className="imm-act" id="standards" aria-labelledby="docs-standards-h">
          <div className="imm-act-head">
            <p className="imm-label">05.3 <em>— standards</em></p>
            <h2 className="imm-h2" id="docs-standards-h" data-reveal>
              Built on named standards, not private plumbing.
            </h2>
          </div>

          <div className="imm-specgrid">
            {STANDARDS.map(([term, body]) => (
              <div className="imm-spec" key={term}>
                <h4>{term}</h4>
                <p>{body}</p>
              </div>
            ))}
          </div>

          <div className="imm-specgrid" style={{ marginTop: "1.2rem" }}>
            {SURFACES.map(([term, body]) => (
              <div className="imm-spec" key={term}>
                <h4>{term}</h4>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── close ─────────────────────────────────────────────── */}
        <section className="imm-cta" data-testid="cta-section" aria-labelledby="docs-next-h">
          <div>
            <p className="imm-label">Next <em>— start</em></p>
            <h2 className="imm-h2" id="docs-next-h" style={{ margin: "0.8rem 0 1rem" }} data-reveal>
              The SDK is published. The gate is deployed.
            </h2>
          </div>
          <div className="imm-cta-actions" data-reveal>
            <a className="imm-btn imm-btn-primary" href="https://github.com/ranaalyan1/avaira.xyz" target="_blank" rel="noreferrer">
              Read the repository
            </a>
          </div>
        </section>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
