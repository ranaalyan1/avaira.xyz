import { useReveal } from "@/lib/motion";
import { Link } from "react-router-dom";
import { ImmersiveNav, ImmersiveFoot, usePageTitle } from "@/pages/immersive/shell";

/* The scoring page, in the immersive language. The weights, the bands and the
 * penalty machine are read from backend/core/reputation.py and IAvaira.sol, and
 * the fee streams are the four the contracts settle — stated as mechanism, with
 * no prices and no projections anywhere on the page. */

const WEIGHTS = [
  ["success rate", "0.30", "share of settled missions that completed inside their envelope"],
  ["intent alignment", "0.20", "how closely executed values tracked the committed envelope"],
  ["slash history", "0.20", "weight of past slashes, decayed over time"],
  ["economic volume", "0.15", "value settled through the gate, not value attempted"],
  ["time on network", "0.10", "age of the identity, from registration"],
  ["appeal resolution", "0.05", "outcome of any challenge raised against the agent"],
];

const LADDER = [
  ["A+", "90 and above", "150% collateral terms, credit market open"],
  ["A", "80 to 89", "110% collateral terms, credit market open"],
  ["B", "70 to 79", "standard terms, expanded envelopes available"],
  ["C", "60 to 69", "restricted envelopes, no new credit"],
  ["D", "below 60", "credit market closed until the score recovers"],
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

const PENALTIES = [
  {
    state: "WARNING",
    what: "the deviation is recorded against the agent and its envelope is tightened",
    back: "no action required",
  },
  {
    state: "SUSPENDED",
    what: "collateral is slashed, the agent is frozen and its credit line is closed",
    back: "re-collateralise after the 24 hour suspension cooldown",
  },
  {
    state: "BANNED",
    what: "the identity is terminal, the bond is burned and the registry marks it permanently",
    back: "no path back",
  },
];

export default function ScorePage() {
  const revealRoot = useReveal();
  usePageTitle("The Avaira score — AVAIRA");

  return (
    <div className="landing-immersive" data-testid="score-page" ref={revealRoot}>
      <ImmersiveNav />

      <header className="imm-pagehead">
        <p className="imm-label">03 <em>— score engine</em></p>
        <h1 data-reveal>One number, six inputs, no discretion.</h1>
        <p className="imm-lead" data-reveal>
          The score decides what an agent may attempt and how much collateral it
          has to post. It is arithmetic over settled outcomes, so two operators
          reading the same history get the same grade — and anyone can recompute
          it and challenge the result on chain.
        </p>
        <ul className="imm-meta">
          <li>deterministic</li>
          <li>published formula</li>
          <li>appealable</li>
        </ul>
      </header>

      <main className="imm-page">
        {/* ── inputs ───────────────────────────────────────────── */}
        <section className="imm-act" id="inputs" aria-labelledby="score-inputs-h">
          <div className="imm-act-head">
            <p className="imm-label">03.1 <em>— inputs</em></p>
            <h2 className="imm-h2" id="score-inputs-h" data-reveal>
              Fixed coefficients. No reviewer in the loop.
            </h2>
          </div>

          <div className="imm-table" data-testid="score-weights" data-reveal>
            {WEIGHTS.map(([term, weight, body]) => (
              <div className="imm-layer" key={term} data-reveal>
                <span className="imm-layer-no">{weight}</span>
                <span className="imm-layer-on">{term}</span>
                <span>{body}</span>
              </div>
            ))}
          </div>
          <p className="imm-body" style={{ marginTop: "1.2rem", maxWidth: "62ch" }} data-reveal>
            Six terms, fixed coefficients. The same history always produces the
            same score, so anyone can recompute it and challenge the result on
            chain.
          </p>
        </section>

        {/* ── the ladder ───────────────────────────────────────── */}
        <section className="imm-act" id="bands" data-testid="score-ladder" aria-labelledby="score-ladder-h">
          <div className="imm-act-head">
            <p className="imm-label">03.2 <em>— bands</em></p>
            <h2 className="imm-h2" id="score-ladder-h" data-reveal>
              Grades set the collateral, not a negotiation.
            </h2>
          </div>

          <div data-reveal>
            <div className="imm-bandtrack" role="img" aria-label="Score bands: D below 60, C 60 to 69, B 70 to 79, A 80 to 89, A+ 90 and above. Sample agent orion-11 sits at 87.4">
              <div className="imm-band">D</div>
              <div className="imm-band">C</div>
              <div className="imm-band">B</div>
              <div className="imm-band imm-band-on">A+</div>
            </div>
            <div className="imm-bandnote">
              <span>0</span>
              <span>orion-11 87.4</span>
              <span>100</span>
            </div>
          </div>

          <div className="imm-table" style={{ marginTop: "2.4rem" }} data-reveal>
            {LADDER.map(([grade, range, terms]) => (
              <div className="imm-layer" key={grade} data-reveal>
                <span className="imm-layer-no">{grade}</span>
                <span className={grade === "A+" ? "imm-layer-on" : undefined}>{range}</span>
                <span>{terms}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── penalties ─────────────────────────────────────────── */}
        <section className="imm-act" id="penalty" data-testid="penalty-ladder" aria-labelledby="score-penalty-h">
          <div className="imm-act-head">
            <p className="imm-label">03.3 <em>— penalty</em></p>
            <h2 className="imm-h2" id="score-penalty-h" data-reveal>
              A state machine, not a notification.
            </h2>
          </div>
          <div className="imm-tracegrid">
            {PENALTIES.map(({ state, what, back }) => (
              <div className="imm-verdict imm-trace" key={state} data-reveal>
                <div className="imm-trace-head">
                  <strong>{state}</strong>
                </div>
                <p className="imm-body" style={{ fontSize: "0.85rem" }}>{what}</p>
                <p className="imm-trace-verdict">{back}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── fee streams ───────────────────────────────────────── */}
        <section className="imm-act" id="revenue" data-testid="revenue-section" aria-labelledby="score-revenue-h">
          <div className="imm-act-head">
            <p className="imm-label">03.4 <em>— fee streams</em></p>
            <h2 className="imm-h2" id="score-revenue-h" data-reveal>
              Four streams the contracts already settle.
            </h2>
            <p className="imm-lead" data-reveal>
              Stated as mechanism only — the splits are enforced by the
              deployed contracts, with no projections attached.
            </p>
          </div>
          <div className="imm-receipts">
            {STREAMS.map((s) => (
              <div className="imm-receipt" key={s.name} data-reveal>
                <h3>{s.name}</h3>
                <p>{s.detail}</p>
              </div>
            ))}
          </div>
          <p className="imm-body" style={{ marginTop: "1.4rem", maxWidth: "62ch" }} data-reveal>
            Underwriting, slashing and anchoring settle in an 85 / 10 / 5 split
            across pool, treasury and anchoring. The weight moves with the
            grade, never with a manual decision.
          </p>
        </section>

        {/* ── close ─────────────────────────────────────────────── */}
        <section className="imm-cta" data-testid="cta-section" aria-labelledby="score-next-h">
          <div>
            <p className="imm-label">Next <em>— the gate</em></p>
            <h2 className="imm-h2" id="score-next-h" style={{ margin: "0.8rem 0 1rem" }} data-reveal>
              The score only matters because the gate enforces it.
            </h2>
          </div>
          <div className="imm-cta-actions" data-reveal>
            <Link className="imm-btn imm-btn-primary" to="/gate">
              Gate mechanics
            </Link>
            <Link className="imm-btn imm-btn-ghost" to="/evidence">
              See the evidence
            </Link>
          </div>
        </section>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
