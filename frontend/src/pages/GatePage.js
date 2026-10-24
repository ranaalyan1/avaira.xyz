import { useNavigate } from "react-router-dom";
import { useAuth } from "@/App";
import { useReveal } from "@/lib/motion";
import { usePageTitle } from "@/lib/pageTitle";
import GatePipeline from "@/components/marketing/GatePipeline";
import GateTrace from "@/components/marketing/GateTrace";
import { RefusalTable } from "@/components/marketing/SpecBlocks";
import {
  ConsoleActions,
  Glyph,
  PageHead,
  PixelFooter,
  PixelFrame,
  PixelNav,
  SectionIndex,
  SpecRows,
} from "@/components/marketing/pixel";

/* The mechanism, end to end. Every label on this page is a name that exists in
 * the contracts: the plane order mirrors IAvaira.sol, the trace fields mirror
 * what the validator records, and the refusal list is the GateReason enum. */

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

const TRACE_FIELDS = [
  ["stage", "envelope, policy, prover, permit — in that order, no skipping"],
  ["ms", "elapsed at that stage, recorded per intent"],
  ["payload", "the value the stage read, and the code it returned when it refused"],
];

export default function GatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  usePageTitle("Gate mechanics — AVAIRA");
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
        n="02"
        section="The gate"
        title="Four planes, passed in order."
        lede="Before any money moves the intent has to clear an envelope, a policy file, a prover and a permit. The gate either returns a signed permit or the code that says why it could not — there is no third outcome and no review queue."
        art="/art/hero.png"
        artGif="/art/hero.gif"
        artAlt="A pixel corridor of four gates with a lit card travelling between them"
        meta={
          <>
            <span>Pre-execution</span>
            <span data-sep>/</span>
            <span>Nine refusal codes</span>
            <span data-sep>/</span>
            <span>Deterministic</span>
          </>
        }
      />

      {/* ── the corridor ─────────────────────────────────────── */}
      <section className="px-section px-section-flat" id="execution" data-testid="how-it-works-section">
        <div className="px-wrap">
          <SectionIndex n="02.1" label="Corridor" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "26ch" }} data-reveal>
            Two intents, the same gate.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            Scroll and the intent travels the corridor. The first passes all four planes and leaves with
            a permit. The second carries a value the envelope never allowed and stops at the policy
            plane, short of the prover.
          </p>

          <div className="px-grid-2" style={{ marginTop: "2.5rem", border: 0, background: "transparent", gap: "1rem" }}>
            <GatePipeline variant="permit" testid="gate-pipeline-permit" />
            <GatePipeline variant="refuse" testid="gate-pipeline-refuse" />
          </div>

          <div style={{ marginTop: "1.5rem" }}>
            <GateTrace />
          </div>
        </div>
      </section>

      {/* ── steps ────────────────────────────────────────────── */}
      <section className="px-section">
        <div className="px-wrap">
          <SectionIndex n="02.2" label="Sequence" />
          <div className="px-steps" style={{ marginTop: "2.5rem" }}>
            {PLANES.map(([n, term, body]) => (
              <article className={`px-step px-step-${n}`} data-testid={`step-${n}`} data-reveal key={term}>
                <h3 className="px-step-term">{term}</h3>
                <p className="px-body" style={{ fontSize: "0.875rem" }}>{body}</p>
              </article>
            ))}
          </div>

          <div className="px-split" style={{ marginTop: "3rem" }}>
            <SpecRows title="What a trace records" rows={TRACE_FIELDS} />
            <PixelFrame
              src="/art/permit.png"
              gif="/art/permit.gif"
              alt="A pixel permit card with a signature drawn across it and a seal stamped into the corner"
              ratio="16 / 9"
              caption="Permit"
              hint="EIP-712 / single use"
            />
          </div>
        </div>
      </section>

      {/* ── refusals ─────────────────────────────────────────── */}
      <section className="px-section" id="moats" data-testid="moats-section">
        <div className="px-wrap">
          <SectionIndex n="02.3" label="Refusals" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "26ch" }} data-reveal>
            Nine ways the gate says no, and one way it says yes.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            A refusal is a value, not an outage. Every blocked intent carries the code for why, which
            makes the reason machine-readable for the agent, the operator and the underwriter at the
            same time.
          </p>

          <div className="px-split" style={{ marginTop: "2.5rem" }}>
            <RefusalTable />
            <div className="px-stack">
              {MOATS.map(({ term, body }, index) => (
                <article className="px-cell" data-testid={`moat-${index}`} data-reveal key={term}>
                  <div className="px-cell-head">
                    <h3 className="px-h3">{term}</h3>
                    <Glyph seed={`MOAT ${index}`} size={18} solid />
                  </div>
                  <p className="px-body" style={{ fontSize: "0.875rem" }}>{body}</p>
                </article>
              ))}
            </div>
          </div>

          <PixelFrame
            src="/art/refuse.png"
            gif="/art/refuse.gif"
            alt="A pixel corridor stopped by a red barrier lowered across it"
            ratio="21 / 9"
            caption="ENVELOPE_MISMATCH"
            hint="GateReason / 9"
            className="px-mt-lg"
          />
        </div>
      </section>

      {/* ── close ────────────────────────────────────────────── */}
      <section className="px-section">
        <div className="px-wrap">
          <h2 className="px-dot px-h2" style={{ maxWidth: "24ch" }} data-reveal>
            Watch it happen on a live intent.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "52ch" }} data-reveal>
            The console runs the same gate against the API and shows each stage as it resolves.
          </p>
          <ConsoleActions onLaunch={goToConsole} />
        </div>
      </section>

      <PixelFooter />
    </div>
  );
}
