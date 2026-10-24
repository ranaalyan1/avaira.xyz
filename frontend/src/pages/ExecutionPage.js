import { useReveal } from "@/lib/motion";
import { Link } from "react-router-dom";
import {
  ImmersiveNav, ImmersiveFoot, RefusalTicker, WORKFLOW, REFUSALS,
  usePageTitle,
} from "@/pages/immersive/shell";

/* Execution — Act IV (the pipeline) and Act V (the decision: the nine refusal
 * codes). Split out of the old single-page landing so the lifecycle deep-links,
 * prerenders and titles on its own. */

export default function ExecutionPage() {
  const revealRoot = useReveal();
  usePageTitle("Execution — five functions, nine refusals — AVAIRA");

  return (
    <div className="landing-immersive" data-testid="execution-page" ref={revealRoot}>
      <ImmersiveNav />

      <main className="imm-page" id="execution">
        {/* Act IV — the execution */}
        <section className="imm-act" data-testid="workflow-section" aria-labelledby="execution-h">
          <div className="imm-act-head">
            <p className="imm-label">Act 04 <em>— the execution</em></p>
            <h2 className="imm-h2" id="execution-h" data-reveal>
              Five functions, in the order the chain enforces them.
            </h2>
            <p className="imm-lead" data-reveal>
              This is the whole lifecycle. Each step is a named function in the
              deployed vault, and the SDK wraps all of them.
            </p>
          </div>
          <div className="imm-pipeline">
            {WORKFLOW.map((s) => (
              <div key={s.no} className="imm-step" data-reveal>
                <p className="imm-step-no">{`Step ${s.no}`}</p>
                <h3>{s.name}</h3>
                <p>{s.body}</p>
                <p><code>{s.fn}</code></p>
              </div>
            ))}
          </div>
        </section>

        {/* Act V — the decision */}
        <section className="imm-act" data-testid="decision-section" aria-labelledby="decision-h">
          <div className="imm-act-head">
            <p className="imm-label">Act 05 <em>— the decision</em></p>
            <h2 className="imm-h2" id="decision-h" data-reveal>
              One view call. Two outcomes. Nine ways to be refused.
            </h2>
          </div>
          <div className="imm-decision">
            <div className="imm-verdict imm-allowed" data-reveal>
              <p className="imm-label" style={{ color: "var(--imm-lime)" }}>Allowed path</p>
              <h3>Permitted</h3>
              <p className="imm-body">
                Every layer passes: a registered identity, stake above minimum, a
                score above 60, a committed intent inside its deadline, matching
                the exact envelope hash. The action runs, the outcome is attested,
                and the challenge window opens.
              </p>
              <p className="imm-reason" style={{ marginTop: "1.2rem" }}>reason: allowed</p>
            </div>
            <div className="imm-verdict imm-rejected" data-reveal>
              <p className="imm-label">Refused path</p>
              <h3>Refused</h3>
              <p className="imm-body">
                Any single failing layer closes the gate before the action runs.
                The refusal is a named, onchain-readable reason, not a 500 from a
                proxy:
              </p>
              <ul className="imm-reasons">
                {REFUSALS.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="imm-body" style={{ marginTop: "1.2rem", fontSize: "0.78rem" }}>
                The examples above are illustrative walkthroughs of the deployed
                contracts, not live transactions.
              </p>
            </div>
          </div>
        </section>

        <RefusalTicker />

        <section className="imm-cta" data-testid="cta-section" aria-labelledby="next-h">
          <div>
            <p className="imm-label">Next <em>— see it live</em></p>
            <h2 className="imm-h2" id="next-h" style={{ margin: "0.8rem 0 1rem" }} data-reveal>
              The contracts are deployed. Read the evidence.
            </h2>
          </div>
          <div className="imm-cta-actions" data-reveal>
            <Link className="imm-btn imm-btn-primary" to="/evidence">
              See the evidence
            </Link>
            <Link className="imm-btn imm-btn-ghost" to="/gate">
              Gate mechanics
            </Link>
          </div>
        </section>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
