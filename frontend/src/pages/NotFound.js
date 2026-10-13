import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div
      className="theme-marketing relative flex min-h-screen items-center justify-center overflow-hidden bg-avaira-bg px-6"
      data-testid="not-found-page"
    >
      <div className="mk-grid-bg absolute inset-0 -z-20" />
      <div className="mk-glow -z-10 left-1/2 top-[-140px] h-[320px] w-[420px] -translate-x-1/2 mk-glow-violet" />

      <div className="mk-card w-full max-w-md p-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-avaira-dim">Error 404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Page not found</h1>
        <p className="mt-3 text-[13px] text-avaira-muted">
          The route you requested does not exist, or it moved while you were away.
        </p>
        <Link to="/" className="mk-btn mk-btn-primary mt-6">
          <ArrowLeft size={15} />
          Return home
        </Link>
      </div>
    </div>
  );
}
