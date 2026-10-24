import { useReveal } from "@/lib/motion";
import { Link } from "react-router-dom";
import { ImmersiveNav, ImmersiveFoot, usePageTitle } from "@/pages/immersive/shell";

/* Gate mechanics — the mechanism end to end, in the immersive language. Every
 * label is a name that exists in the contracts: the plane order mirrors
 * IAvaira.sol, the trace fields mirror what the validator records, and the
 * refusal list is the GateReason enum. */

const PLANES = [
  ["01", "Envelope", "The agent declares a spend ceiling and the actions it is allowed to take. Nothing about the envelope is advisory: it is the value every later stage is compared against."],
  ["02", "Commitment", "That envelope is hashed and committed before the action is attempted, so the terms cannot be rewritten after the fact."],
  ["03", "Policy", "A versioned Rego file decides whether this class of action is allowed at all. Policies are files in the repository, reviewed like code and tested by the same CI."],
  ["04", "Prover", "Interval arithmetic checks the intent against hard invariants. On a violation it returns the interval that broke the invariant, which is evidence rather than a status message."],
  ["05", "Permit", "An EIP-712 signature is issued for this intent, this agent and this deadline, and for nothing else. It is single use, and the store of used intents is on chain."],
  ["06", "Settlement", "The outcome is attested against the committed envelope, the fee is split and the score is updated from the result."],
];

const MOATS = [
  {
    term: "Committed before execution",
    body: "An intent that was never committed cannot be executed, so there is no window in which an agent can act first and explain later.",
  },
  {
    term: "Single-use permissions",
    body: "A permit is bound to one intent hash and burns on use. Replaying an approved intent against a second target returns INTENT_ALREADY_EXECUTED.",
  },
  {
    term: "Witnesses, not verdicts",
    body: "When the prover refuses, it returns the interval that broke the invariant. A refusal is evidence a counterparty can read, not a status message.",
  },
  {
    term: "Score attached to collateral",
    body: "The rating only carries weight because it moves real money: grades set collateral ratios, and a slash moves the grade down.",
  },
  {
    term: "Blast radius contained",
    body: "The gate is a callable wrapper, not a model hook. It reasons about the intent, the target and the value, so the worst case is one refused call.",
  },
];

const STAGES = ["intent", "envelope", "policy", "prover", "permit"];

const TRACE_FIELDS = [
  ["stage", "envelope, policy, prover, permit — in that order, no skipping"],
  ["ms", "elapsed at that stage, recorded per intent"],
  ["payload", "the value the stage read, and the code it returned when it refused"],
];

const REASONS = [
  ["ALLOWED", "agent cleared to execute"],
  ["UNKNOWN_AGENT", "no identity is registered for this address"],
  ["BANNED", "terminal ban, no path back"],
  ["SUSPENDED", "slashed into suspension, waiting on collateral"],
  ["STAKE_TOO_LOW", "bond sits below the minimum the envelope requires"],
  ["SCORE_TOO_LOW", "Avaira Score under the floor the mission demands"],
  ["INTENT_NOT_COMMITTED", "no commitment matches the intent hash"],
  ["INTENT_EXPIRED", "the envelope deadline has passed"],
  ["INTENT_ALREADY_EXECUTED", "the intent is single use and was already attested"],
  ["ENVELOPE_MISMATCH", "the stored envelope does not match the committed hash"],
];

const PERMITTED_TRACE = {
  title: "Permitted",
  intent: "search.market_data",
  lines: [
    ["intent", "0.0", "agent atlas-04 declares 12.40 USD to api.marketdata"],
    ["envelope", "0.3", "max_spend_usd 50.00, within bounds"],
    ["policy", "0.5", "shield_rules.rego allows search"],
    ["prover", "0.9", "interval [0.00, 50.00] proves SAFE"],
    ["permit", "1.2", "EIP-712 signed, single use, deadline set"],
  ],
  verdict: "executed with a permit attached",
};

const REFUSED_TRACE = {
  title: "Refused",
  intent: "transfer.usdc",
  lines: [
    ["intent", "0.0", "agent orion-11 declares 840.00 USD to 0x9B95"],
    ["envelope", "0.4", "max_spend_usd 50.00, declared 840.00"],
    ["policy", "0.6", "shield_rules.rego refuses transfer"],
    ["prover", "skip", "not reached, gate closed"],
    ["permit", "none", "ENVELOPE_MISMATCH"],
  ],
  verdict: "execute_fn was never called",
};

function TracePanel({ trace, testid, allowed }) {
  return (
    <figure className="imm-verdict imm-trace" data-testid={testid} data-reveal>
      <div className="imm-trace-head">
        <strong>{trace.title}</strong>
        <span>intent {trace.intent}</span>
      </div>
      {trace.lines.map(([stage, ms, detail]) => (
        <div className="imm-trace-row" data-gate={stage} key={stage}>
          <span>{stage}</span>
          <span>{ms}</span>
          <span>{detail}</span>
        </div>
      ))}
      <p className="imm-trace-verdict" style={{ color: allowed ? "var(--imm-lime)" : "var(--imm-paper)" }}>
        {trace.verdict}
      </p>
    </figure>
  );
}

export default function GatePage() {
  const revealRoot = useReveal();
  usePageTitle("Gate mechanics — AVAIRA");

  return (
    <div className="landing-immersive" data-testid="gate-page" ref={revealRoot}>
      <ImmersiveNav />

      <header className="imm-pagehead">
        <p className="imm-label">02 <em>— the gate</em></p>
        <h1 data-reveal>Four planes, passed in order.</h1>
        <p className="imm-lead" data-reveal>
          Before any money moves the intent has to clear an envelope, a policy
          file, a prover and a permit. The gate either returns a signed permit or
          the code that says why it could not — there is no third outcome and no
          review queue.
        </p>
        <ul className="imm-meta">
          <li>pre-execution</li>
          <li>nine refusal codes</li>
          <li>deterministic</li>
        </ul>
      </header>

      <main className="imm-page">
        {/* ── the corridor ─────────────────────────────────────── */}
        <section className="imm-act" id="execution" data-testid="how-it-works-section" aria-labelledby="gate-corridor-h">
          <div className="imm-act-head">
            <p className="imm-label">02.1 <em>— corridor</em></p>
            <h2 className="imm-h2" id="gate-corridor-h" data-reveal>
              Two intents, the same gate.
            </h2>
            <p className="imm-lead" data-reveal>
              The first intent passes all four planes and leaves with a permit.
              The second carries a value the envelope never allowed and stops at
              the policy plane, short of the prover.
            </p>
          </div>

          <div className="imm-decision">
            <div className="imm-verdict imm-allowed" data-testid="gate-pipeline-permit" data-reveal>
              <p className="imm-label" style={{ color: "var(--imm-lime)" }}>Intent 01</p>
              <h3>search.market_data — 12.40 USD</h3>
              <p className="imm-body">
                Declared inside the envelope, allowed by policy, proven safe by
                interval arithmetic.
              </p>
              <div className="imm-stages">
                {STAGES.map((s) => (
                  <span className="imm-stage imm-stage-on" key={s}>{s}</span>
                ))}
              </div>
              <p className="imm-trace-verdict" style={{ color: "var(--imm-lime)" }}>
                ALLOWED — four planes cleared, permit signed, execution proceeds
                under the declared ceiling
              </p>
            </div>
            <div className="imm-verdict imm-rejected" data-testid="gate-pipeline-refuse" data-reveal>
              <p className="imm-label">Intent 02</p>
              <h3>transfer.usdc — 840.00 USD</h3>
              <p className="imm-body">
                The declared value never matched the committed envelope, so the
                corridor closes at the policy plane.
              </p>
              <div className="imm-stages">
                <span className="imm-stage imm-stage-on">intent</span>
                <span className="imm-stage imm-stage-on">envelope</span>
                <span className="imm-stage imm-stage-on">policy</span>
                <span className="imm-stage imm-stage-off">prover</span>
                <span className="imm-stage imm-stage-off">permit</span>
              </div>
              <p className="imm-trace-verdict">
                ENVELOPE_MISMATCH — the stored envelope never matched the
                committed hash, so the prover and the permit were not reached
              </p>
            </div>
          </div>

          <div className="imm-tracegrid">
            <TracePanel trace={PERMITTED_TRACE} testid="trace-permitted" allowed />
            <TracePanel trace={REFUSED_TRACE} testid="trace-refused" />
          </div>
        </section>

        {/* ── the planes ───────────────────────────────────────── */}
        <section className="imm-act" aria-labelledby="gate-planes-h">
          <div className="imm-act-head">
            <p className="imm-label">02.2 <em>— sequence</em></p>
            <h2 className="imm-h2" id="gate-planes-h" data-reveal>
              Six named steps, none of them optional.
            </h2>
          </div>
          <div className="imm-pipeline">
            {PLANES.map(([no, term, body]) => (
              <div key={no} className="imm-step" data-testid={`step-${no}`} data-reveal>
                <p className="imm-step-no">{`Plane ${no}`}</p>
                <h3>{term}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>

          <div className="imm-specgrid" style={{ marginTop: "2.6rem" }} data-reveal>
            {TRACE_FIELDS.map(([term, body]) => (
              <div className="imm-spec" key={term}>
                <h4>{term}</h4>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── refusals ─────────────────────────────────────────── */}
        <section className="imm-act" id="moats" data-testid="moats-section" aria-labelledby="gate-refusal-h">
          <div className="imm-act-head">
            <p className="imm-label">02.3 <em>— refusals</em></p>
            <h2 className="imm-h2" id="gate-refusal-h" data-reveal>
              Nine ways the gate says no, and one way it says yes.
            </h2>
            <p className="imm-lead" data-reveal>
              A refusal is a value, not an outage. Every blocked intent carries
              the code for why, which makes the reason machine-readable for the
              agent, the operator and the underwriter at the same time.
            </p>
          </div>

          <div className="imm-table" data-testid="refusal-table" data-reveal>
            {REASONS.map(([code, meaning], i) => (
              <div className="imm-layer" key={code} data-reveal>
                <span className="imm-layer-no">{String(i + 1).padStart(2, "0")}</span>
                <span className={code === "ALLOWED" ? "imm-layer-on" : undefined}>{code}</span>
                <span>{meaning}</span>
              </div>
            ))}
          </div>

          <div className="imm-receipts" style={{ marginTop: "2.6rem" }}>
            {MOATS.map(({ term, body }, index) => (
              <div className="imm-receipt" data-testid={`moat-${index}`} key={term} data-reveal>
                <h3>{term}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── close ────────────────────────────────────────────── */}
        <section className="imm-cta" data-testid="cta-section" aria-labelledby="gate-next-h">
          <div>
            <p className="imm-label">Next <em>— see it live</em></p>
            <h2 className="imm-h2" id="gate-next-h" style={{ margin: "0.8rem 0 1rem" }} data-reveal>
              The contracts are deployed. Read the evidence.
            </h2>
          </div>
          <div className="imm-cta-actions" data-reveal>
            <Link className="imm-btn imm-btn-primary" to="/evidence">
              See the evidence
            </Link>
            <Link className="imm-btn imm-btn-ghost" to="/execution">
              The lifecycle
            </Link>
          </div>
        </section>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
