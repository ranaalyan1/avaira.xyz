import { useNavigate } from "react-router-dom";
import { useAuth } from "@/App";
import { useReveal } from "@/lib/motion";
import { usePageTitle } from "@/lib/pageTitle";
import { PenaltyLadder, ScoreLadder, ScoreWeights } from "@/components/marketing/SpecBlocks";
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

/* The scoring page. The weights, the bands and the penalty machine are read
 * from backend/core/reputation.py and IAvaira.sol, and the fee streams are the
 * four the contracts settle — stated as mechanism, with no prices and no
 * projections anywhere on the page. */

const INPUTS = [
  ["success rate", "share of settled missions that completed inside their envelope"],
  ["intent alignment", "how closely executed values tracked the committed envelope"],
  ["slash history", "weight of past slashes, decayed over time"],
  ["economic volume", "value settled through the gate, not value attempted"],
  ["time on network", "age of the identity, from registration"],
  ["appeal resolution", "outcome of any challenge raised against the agent"],
];

const STREAMS = [
  {
    name: "Underwriting spread",
    detail: "5% of every settled mission, split across the backers who staked against it.",
  },
  {
    name: "Slashing share",
    detail: "20% of slashed collateral reaches the treasury; the remainder compensates the pool first.",
  },
  {
    name: "Anchoring",
    detail: "Merkle roots committed on chain, batched across each agent's intents.",
  },
  {
    name: "Data and scores",
    detail: "Per-query access to scores, refusal history and settlement records.",
  },
];

const LADDER = [
  ["A+", "90 and above", "150% collateral terms, credit market open"],
  ["A", "80 to 89", "110% collateral terms, credit market open"],
  ["B", "70 to 79", "standard terms, expanded envelopes available"],
  ["C", "60 to 69", "restricted envelopes, no new credit"],
  ["D", "below 60", "credit market closed until the score recovers"],
];

export default function ScorePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  usePageTitle("The Avaira score — AVAIRA");
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
        n="03"
        section="Score engine"
        title="One number, six inputs, no discretion."
        lede="The score decides what an agent may attempt and how much collateral it has to post. It is arithmetic over settled outcomes, so two operators reading the same history get the same grade — and anyone can recompute it and challenge the result on chain."
        art="/art/score.png"
        artGif="/art/score.gif"
        artAlt="A pixel gauge with a lit arc and a single needle"
        meta={
          <>
            <span>Deterministic</span>
            <span data-sep>/</span>
            <span>Published formula</span>
            <span data-sep>/</span>
            <span>Appealable</span>
          </>
        }
      />

      {/* ── weights ──────────────────────────────────────────── */}
      <section className="px-section px-section-flat">
        <div className="px-wrap">
          <SectionIndex n="03.1" label="Inputs" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "24ch" }} data-reveal>
            Six terms, fixed coefficients.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            Every term is measured from settled history. Nothing in the formula is a judgement call, and
            no operator can adjust a score by hand.
          </p>

          <div style={{ marginTop: "2.5rem" }}>
            <ScoreWeights />
          </div>

          <div className="px-split" style={{ marginTop: "3rem" }}>
            <SpecRows title="What each term measures" rows={INPUTS} />
            <div className="px-cell">
              <div className="px-cell-head">
                <h3 className="px-h3">Bands</h3>
                <Glyph seed="BANDS" size={18} solid />
              </div>
              <div className="px-spec">
                {LADDER.map(([grade, range, terms]) => (
                  <div className="px-spec-row" data-reveal key={grade}>
                    <span className="px-spec-key" style={{ color: "var(--px-hi)", fontSize: "0.875rem" }}>{grade}</span>
                    <span className="px-spec-value">
                      {range}
                      <br />
                      <span className="px-mute">{terms}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: "3rem" }}>
            <ScoreLadder />
          </div>
        </div>
      </section>

      {/* ── penalty ──────────────────────────────────────────── */}
      <section className="px-section" id="penalty">
        <div className="px-wrap">
          <SectionIndex n="03.2" label="Penalty" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "24ch" }} data-reveal>
            What happens after a deviation.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            Enforcement is a state machine. Each step says what changes, how long it lasts and what it
            takes to come back, and every transition is recorded with its reason code and the block it
            happened in.
          </p>

          <div className="px-split" style={{ marginTop: "2.5rem" }}>
            <PenaltyLadder />
            <PixelFrame
              src="/art/burn.png"
              gif="/art/burn.gif"
              alt="A pixel stack of bonded plates burning down under a falling red slash mark"
              ratio="4 / 5"
              caption="Slash"
              hint="collateral burned, pool paid first"
            />
          </div>
        </div>
      </section>

      {/* ── economics ────────────────────────────────────────── */}
      <section className="px-section" id="revenue" data-testid="revenue-section">
        <div className="px-wrap">
          <SectionIndex n="03.3" label="Fee streams" />
          <h2 className="px-dot px-h2" style={{ marginTop: "1.25rem", maxWidth: "26ch" }} data-reveal>
            Four streams, all of them from settled activity.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "62ch" }} data-reveal>
            The protocol earns when a mission settles or when collateral is slashed, never for sitting in
            the path. There are no tiers and no per-check charge: the gate is not metered, so widening an
            envelope does not change what an integration costs to run.
          </p>

          <div className="px-grid-2" style={{ marginTop: "2.5rem" }}>
            <div className="px-cell">
              <div className="px-cell-head">
                <h3 className="px-h3">Where the fee comes from</h3>
                <Glyph seed="FEES" size={18} solid />
              </div>
              <div className="px-spec">
                {STREAMS.map(({ name, detail }) => (
                  <div className="px-spec-row" data-reveal key={name}>
                    <span className="px-spec-key">{name}</span>
                    <span className="px-spec-value">{detail}</span>
                  </div>
                ))}
              </div>
            </div>

            <PixelFrame
              src="/art/network.png"
              gif="/art/network.gif"
              alt="A pixel lattice of connected nodes with pulses travelling the links"
              ratio="16 / 10"
              caption="Underwriting"
              hint="85 / 10 / 5 split"
            />
          </div>
        </div>
      </section>

      {/* ── close ────────────────────────────────────────────── */}
      <section className="px-section">
        <div className="px-wrap">
          <h2 className="px-dot px-h2" style={{ maxWidth: "24ch" }} data-reveal>
            Read a score off a live agent.
          </h2>
          <p className="px-body" style={{ marginTop: "1rem", maxWidth: "52ch" }} data-reveal>
            The reputation view in the console shows every input behind a grade and the movement between
            scoring runs.
          </p>
          <ConsoleActions onLaunch={goToConsole} />
        </div>
      </section>

      <PixelFooter />
    </div>
  );
}
