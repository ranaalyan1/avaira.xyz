import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Glyph } from "@/components/marketing/pixel";
import { usePageTitle } from "@/lib/pageTitle";

export default function NotFound() {
  usePageTitle("Page not found — AVAIRA");
  return (
    <div className="px-site px-login" data-testid="not-found-page">
      <span className="px-login-veil" aria-hidden="true" />

      <div className="px-login-inner" style={{ textAlign: "center" }}>
        <span className="px-login-mark" aria-hidden="true">
          <Glyph seed="404" size={40} solid />
        </span>
        <p className="px-label" style={{ marginTop: "1rem" }}>
          Error 404
        </p>
        <h1 className="px-dot px-h2" style={{ marginTop: "0.75rem" }}>
          No route here
        </h1>
        <p className="px-body" style={{ marginTop: "1rem", maxWidth: "44ch", marginInline: "auto" }}>
          The path you asked for does not exist, or it moved while you were away. Nothing was executed.
        </p>

        <div className="px-hero-actions" style={{ justifyContent: "center", marginTop: "2rem" }}>
          <Link className="px-btn px-btn-accent px-btn-lg" to="/">
            <ArrowLeft size={15} strokeWidth={2} />
            Return home
          </Link>
          <Link className="px-btn px-btn-quiet px-btn-lg" to="/gate">
            Read the mechanism
          </Link>
        </div>
      </div>
    </div>
  );
}
