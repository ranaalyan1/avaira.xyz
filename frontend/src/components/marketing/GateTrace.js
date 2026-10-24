/**
 * Gate traces.
 *
 * The protocol's own artifact, not a marketing illustration: the field names
 * and the millisecond column mirror what an intent actually produces
 * (`validator.py` records `latency_ms` per stage, and the refusal codes are the
 * `GateReason` enum in IAvaira.sol). Two traces are shown side by side because
 * the refusal is the more important one to see.
 *
 * Lines reveal in order on scroll. Nothing here is randomised — the rows are
 * the same every time the page is loaded.
 */
import { DARK } from "@/lib/palette";
import { animate, useEnterAnimation, stagger } from "@/lib/motion";

const OPTIONS = { opacity: [0, 1], translateX: [-8, 0], duration: 520, delay: stagger(90), ease: "out(3)" };

const REFUSED = {
  title: "Refused",
  tone: DARK.danger,
  intent: "transfer.usdc",
  lines: [
    ["intent", "0.0", "agent orion-11 declares 840.00 USD to 0x9B95", DARK.textPrimary],
    ["envelope", "0.4", "max_spend_usd 50.00, declared 840.00", DARK.textPrimary],
    ["policy", "0.6", "shield_rules.rego refuses transfer", DARK.textPrimary],
    ["prover", "skip", "not reached, gate closed", DARK.textMuted],
    ["permit", "none", "ENVELOPE_MISMATCH", DARK.danger],
  ],
  verdict: "execute_fn was never called",
};

const PERMITTED = {
  title: "Permitted",
  tone: DARK.success,
  intent: "search.market_data",
  lines: [
    ["intent", "0.0", "agent atlas-04 declares 12.40 USD to api.marketdata", DARK.textPrimary],
    ["envelope", "0.3", "max_spend_usd 50.00, within bounds", DARK.textPrimary],
    ["policy", "0.5", "shield_rules.rego allows search", DARK.textPrimary],
    ["prover", "0.9", "interval [0.00, 50.00] proves SAFE", DARK.textPrimary],
    ["permit", "1.2", "EIP-712 signed, single use, deadline set", DARK.success],
  ],
  verdict: "executed with a permit attached",
};

const TracePanel = ({ trace, testid, delay }) => {
  const ref = useEnterAnimation((_scope, root) => {
    const rows = root.querySelectorAll("[data-trace-row]");
    animate(rows, { ...OPTIONS, delay: stagger(90, { start: delay }) });
  });

  return (
    <figure className="trace-panel" ref={ref} data-testid={testid}>
      <figcaption className="trace-head">
        <span className="trace-title" style={{ color: trace.tone }}>
          {trace.title}
        </span>
        <span className="trace-meta">intent {trace.intent}</span>
      </figcaption>

      <div className="trace-body">
        <div className="trace-columns" aria-hidden="true">
          <span>stage</span>
          <span>ms</span>
          <span>payload</span>
        </div>
        {trace.lines.map(([stage, ms, detail, tone]) => (
          <div className="trace-row" data-trace-row key={stage}>
            <span className="trace-stage">{stage}</span>
            <span className="trace-ms">{ms}</span>
            <span className="trace-detail" style={{ color: tone }}>
              {detail}
            </span>
          </div>
        ))}
      </div>

      <p className="trace-verdict" style={{ color: trace.tone }}>
        {trace.verdict}
      </p>
    </figure>
  );
};

export default function GateTrace() {
  return (
    <div className="trace-grid" data-testid="gate-traces">
      <TracePanel trace={PERMITTED} testid="trace-permitted" delay={0} />
      <TracePanel trace={REFUSED} testid="trace-refused" delay={260} />
    </div>
  );
}
