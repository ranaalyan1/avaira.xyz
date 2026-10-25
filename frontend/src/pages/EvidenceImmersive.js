import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useReveal, prefersReducedMotion } from "@/lib/motion";
import {
  ImmersiveNav, ImmersiveFoot, EXPLORER, DEPLOYMENTS,
  usePageTitle,
} from "@/pages/immersive/shell";

/* Evidence — Act VI (the deployments and the receipts) and Act VII (the
 * architecture). Split out of the old single-page landing so the verifiable
 * claims deep-link, prerender and title on their own. The receipt numbers count
 * up once when the row scrolls into view; reduced motion and prerendering render
 * the final values. */

export default function EvidencePage() {
  const revealRoot = useReveal();
  usePageTitle("Evidence — deployed, wired, verifiable — AVAIRA");
  const receiptsRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    const row = receiptsRef.current;
    if (!row || prefersReducedMotion()) return undefined;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      row.querySelectorAll("strong").forEach((el) => {
        const final = parseInt(el.textContent, 10);
        if (!Number.isFinite(final)) return;
        const start = performance.now();
        const tick = (now) => {
          if (cancelled) return;
          const t = Math.min(1, (now - start) / 1400);
          const eased = 1 - Math.pow(1 - t, 3);
          el.textContent = String(Math.round(eased * final));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.4 });
    io.observe(row);
    return () => { cancelled = true; io.disconnect(); };
  }, []);

  return (
    <div className="landing-immersive" data-testid="evidence-page" ref={revealRoot}>
      <ImmersiveNav />

      <main className="imm-page" id="evidence">
        {/* Act VI — the evidence */}
        <section className="imm-act" data-testid="evidence-section" aria-labelledby="evidence-h">
          <div className="imm-act-head">
            <p className="imm-label">Act 06 <em>— the evidence</em></p>
            <h2 className="imm-h2" id="evidence-h" data-reveal>
              Deployed, wired, and verifiable from the explorer.
            </h2>
            <p className="imm-lead" data-reveal>
              {`Robinhood Chain mainnet, chain id 4663. Every address below is live
                and liveness-checked by a make target in the repository. Real
                chain, real stakes.`}
            </p>
          </div>
          <div style={{ overflowX: "auto" }} data-reveal>
            <table className="imm-table" data-testid="evidence-table">
              <caption className="sr-only">Avaira contracts deployed on Robinhood Chain mainnet</caption>
              <thead>
                <tr>
                  <th scope="col">Contract</th>
                  <th scope="col">Address (chain 4663)</th>
                  <th scope="col">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {DEPLOYMENTS.map(([name, addr]) => (
                  <tr key={addr}>
                    <td>{name}</td>
                    <td className="imm-addr">{addr}</td>
                    <td><a href={`${EXPLORER}/${addr}`}>view</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="imm-receipts" data-reveal ref={receiptsRef}>
            <div className="imm-receipt">
              <p className="imm-label">Foundry tests</p>
              <strong>157</strong>
              <span>passing, 0 skipped, run locally</span>
            </div>
            <div className="imm-receipt">
              <p className="imm-label">Fuzz campaign</p>
              <strong>2000</strong>
              <span>sequences, 12 invariants, 0 violations</span>
            </div>
            <div className="imm-receipt">
              <p className="imm-label">Red-team findings</p>
              <strong>15</strong>
              <span>each with replay command and status</span>
            </div>
            <div className="imm-receipt">
              <p className="imm-label">Parity vectors</p>
              <strong>42</strong>
              <span>identical on-chain, Python, TypeScript</span>
            </div>
          </div>
        </section>

        {/* Act VII — the architecture */}
        <section className="imm-act" id="architecture" data-testid="architecture-section" aria-labelledby="arch-h">
          <div className="imm-act-head">
            <p className="imm-label">Act 07 <em>— the architecture</em></p>
            <h2 className="imm-h2" id="arch-h" data-reveal>
              Six contracts, two services, two SDKs, one public formula.
            </h2>
          </div>
          <div className="imm-stack" data-reveal>
            <div className="imm-stack-row">
              <h3>Protocol contracts</h3>
              <p>Identity, reputation, validation, stake, intent vault, credit market, plus the settlement token. Foundry, 126 onchain test functions, machine-checked invariants.</p>
              <a href="https://github.com/ranaalyan1/avaira.xyz">source</a>
            </div>
            <div className="imm-stack-row">
              <h3>Scorer service</h3>
              <p>The 0-100 score as pure functions, with grade parity pinned against the on-chain table by test.</p>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/services/scorer">source</a>
            </div>
            <div className="imm-stack-row">
              <h3>Gateway service</h3>
              <p>The offchain half: HMAC-signed requests, single-use nonces, a per-agent circuit breaker, and one read-only gate call. It never broadcasts.</p>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/services/gateway">source</a>
            </div>
            <div className="imm-stack-row">
              <h3>SDKs</h3>
              <p>TypeScript and Python, sharing the same 42 canonical parity vectors as the contracts.</p>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/sdk">source</a>
            </div>
            <div className="imm-stack-row">
              <h3>Audit package</h3>
              <p>Threat model, invariants, risk register and 15 findings with replay commands. Self-adversarial, labelled as such; not a third-party audit.</p>
              <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/audit">read</a>
            </div>
          </div>
        </section>

        <section className="imm-cta" data-testid="cta-section" aria-labelledby="cta-evidence">
          <div>
            <p className="imm-label">Verify <em>— do not take our word</em></p>
            <h2 className="imm-h2" id="cta-evidence" style={{ margin: "0.8rem 0 1rem" }} data-reveal>
              Every claim on this page has a command behind it.
            </h2>
          </div>
          <div className="imm-cta-actions" data-reveal>
            <Link className="imm-btn imm-btn-primary" to="/ledger">
              The evidence ledger
            </Link>
            <a className="imm-btn imm-btn-ghost" href="https://github.com/ranaalyan1/avaira.xyz/tree/main/audit">
              Read the audit package
            </a>
          </div>
        </section>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
