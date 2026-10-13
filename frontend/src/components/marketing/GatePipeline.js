/**
 * The gate, in three dimensions.
 *
 * Four planes recede down a corridor — envelope, policy, prover, permit — and an
 * intent card travels through them as the page scrolls. It is a real CSS 3D
 * scene: `perspective` on the frame, `translateZ` on the planes and on the card,
 * and an anime.js timeline linked to scroll position (`sync: true`), so the page
 * position *is* the animation position and the whole thing runs backwards when
 * you scroll up.
 *
 * Two corridors are rendered and the difference between them is the point:
 *   permit  the card passes all four planes
 *   refuse  the card stops at the policy plane, short of the prover
 *
 * With reduced motion (or no JavaScript) the scene stays in its resolved state,
 * which is what the stylesheet describes: the card where it finally came to rest.
 */
import { useState } from "react";
import { DARK } from "@/lib/palette";
import { useScrubTimeline } from "@/lib/motion";

const PLANES = [
  { key: "envelope", label: "Envelope", detail: "spend ceiling, allowed actions" },
  { key: "policy", label: "Policy", detail: "OPA Rego, versioned with the repo" },
  { key: "prover", label: "Prover", detail: "interval arithmetic over invariants" },
  { key: "permit", label: "Permit", detail: "EIP-712 signature, single use" },
];

const SPACING = 170;
const CARD_RESTING_Z = 34;

export default function GatePipeline({ variant = "permit", testid = "gate-pipeline" }) {
  const refused = variant === "refuse";
  const planesCleared = refused ? 1 : PLANES.length;
  const travel = planesCleared * SPACING;
  const [passed, setPassed] = useState(planesCleared);

  const ref = useScrubTimeline(
    (timeline) => {
      // The card only moves on the Z axis; the centring translate lives on the
      // wrapper so the timeline never has to reason about percentages.
      timeline.add(".intent-travel", {
        translateZ: [CARD_RESTING_Z, CARD_RESTING_Z - travel],
        duration: 1000,
      });
    },
    {
      onProgress: (progress) => {
        const cleared = Math.min(planesCleared, Math.max(0, Math.floor(progress * planesCleared + 0.0001)));
        setPassed((current) => (current === cleared ? current : cleared));
      },
    }
  );

  return (
    <figure
      className={`pipeline ${refused ? "is-refused" : "is-permitted"}`}
      ref={ref}
      data-testid={testid}
    >
      <figcaption className="pipeline-head">
        <span className="pipeline-variant">{refused ? "Refused" : "Permitted"}</span>
        <span className="pipeline-intent">
          {refused ? "transfer.usdc 840.00 USD" : "search.market_data 12.40 USD"}
        </span>
      </figcaption>

      <div className="pipeline-frame">
        <div className="pipeline-scene">
          {PLANES.map((plane, index) => {
            const isPassed = index < passed;
            const isBlocked = refused && index === planesCleared;
            const isBeyond = refused && index > planesCleared;
            return (
              <div
                key={plane.key}
                className={`gate-plane${isPassed ? " is-passed" : ""}${isBlocked ? " is-blocked" : ""}${isBeyond ? " is-beyond" : ""}`}
                style={{ transform: `translate(-50%, -50%) translateZ(${-(index + 1) * SPACING}px)` }}
                data-gate={plane.key}
              >
                <span className="gate-label">{plane.label}</span>
                <span className="gate-detail">{plane.detail}</span>
              </div>
            );
          })}

          <div className="intent-anchor">
            <div className="intent-travel">
              <div className="intent-card">
                <span className="intent-card-key">intent</span>
                <span className="intent-card-value">{refused ? "840.00 USD" : "12.40 USD"}</span>
                <span className="intent-card-action">{refused ? "transfer.usdc" : "search.market_data"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="pipeline-status">
        <span className="pipeline-status-code" style={{ color: refused ? DARK.danger : DARK.success }}>
          {refused ? "ENVELOPE_MISMATCH" : "ALLOWED"}
        </span>
        <span className="pipeline-status-text">
          {refused
            ? "the stored envelope never matched the committed hash, so the prover and the permit were not reached"
            : "four planes cleared, permit signed, execution proceeds under the declared ceiling"}
        </span>
      </p>
    </figure>
  );
}
