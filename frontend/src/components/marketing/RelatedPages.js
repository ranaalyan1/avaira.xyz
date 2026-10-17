/**
 * "Keep reading" block: internal links between the marketing pages.
 *
 * Every page names the two or three pages that answer the question a reader
 * naturally has next, so the site reads as one document instead of five
 * islands — and crawlers get a consistent internal link graph.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";

const PAGES = {
  home: { to: "/", label: "Overview", body: "The rule the protocol enforces, stated once." },
  gate: { to: "/gate", label: "The gate", body: "Envelope, policy, prover and the permit, end to end." },
  score: { to: "/score", label: "The score", body: "Six weighted inputs anyone can recompute." },
  evidence: { to: "/evidence", label: "The evidence", body: "Latency, coverage and refusal counts, measured in CI." },
  docs: { to: "/docs", label: "Integration", body: "One call around the function that spends." },
  contact: { to: "/contact", label: "Contact", body: "Reach the team behind the gate." },
};

export default function RelatedPages({ items, testid = "related-pages" }) {
  const entries = (items || []).map((key) => PAGES[key]).filter(Boolean);
  if (!entries.length) return null;
  return (
    <section className="px-section" aria-label="Related pages" data-testid={testid}>
      <div className="px-wrap">
        <p className="px-label" style={{ marginBottom: "1.25rem" }}>Keep reading</p>
        <div className="px-grid-3" style={{ gap: "1px" }}>
          {entries.map((page) => (
            <Link
              key={page.to}
              to={page.to}
              className="px-related-card"
              style={{
                display: "block",
                border: "1px solid rgba(255,255,255,0.14)",
                padding: "1.25rem 1.25rem 1.4rem",
              }}
            >
              <span className="px-mono px-mute" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
                {page.label}
              </span>
              <p className="px-body" style={{ marginTop: "0.6rem", fontSize: "13px" }}>{page.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
