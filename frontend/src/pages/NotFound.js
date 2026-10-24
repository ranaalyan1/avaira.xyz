import { Link } from "react-router-dom";
import { usePageTitle } from "@/pages/immersive/shell";

/* 404, in the immersive language. */
export default function NotFound() {
  usePageTitle("No route here — AVAIRA");

  return (
    <div className="landing-immersive" data-testid="not-found-page">
      <main className="imm-404">
        <p className="imm-label">404 <em>— refusal</em></p>
        <h1>
          No route here<span style={{ color: "var(--imm-lime)" }}>.</span>
        </h1>
        <p className="imm-body" data-testid="not-found-copy">
          This is a refusal, not an outage: the address you asked for does not
          match any route the protocol serves.
        </p>
        <div className="imm-cta-actions" style={{ justifyContent: "center" }}>
          <Link className="imm-btn imm-btn-primary" to="/">
            Back to the boundary
          </Link>
          <Link className="imm-btn imm-btn-ghost" to="/gate">
            Gate mechanics
          </Link>
        </div>
      </main>
    </div>
  );
}
