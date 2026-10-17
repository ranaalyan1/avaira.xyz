import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldCheck, Unplug } from "lucide-react";
import { API } from "@/lib/api";
import { useAuth } from "@/App";
import { animate, stagger, useEnterAnimation, usePointerTilt } from "@/lib/motion";
import { useSeo } from "@/lib/seo";
import { track } from "@/lib/analytics";
import { Glyph } from "@/components/marketing/pixel";

export default function Login() {
  const navigate = useNavigate();

  useSeo({
    title: "Sign in",
    description:
      "Sign in to the AVAIRA console to register agents, declare risk envelopes and watch intents clear the gate.",
    path: "/login",
  });
  // Set by App when /api/* comes back as the SPA's own HTML, which means this
  // deployment has no backend: the OAuth buttons below would navigate to
  // `${API}/auth/...`, be answered by the SPA rewrite, and dump the visitor on
  // the app's 404 page. Say what is actually wrong instead.
  const { backendMisconfigured } = useAuth();
  const cardTilt = usePointerTilt({ max: 3 });
  const entrance = useEnterAnimation((_scope, root) => {
    animate(root.querySelectorAll("[data-login-enter]"), {
      opacity: [0, 1],
      translateY: [12, 0],
      duration: 520,
      delay: stagger(80),
      ease: "out(3)",
    });
  });

  const handleGoogleLogin = () => {
    if (backendMisconfigured) return;
    track("signin_started", { provider: "google" });
    const redirectUrl = window.location.origin + "/dashboard";
    window.location.href = `${API}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const handleXLogin = () => {
    if (backendMisconfigured) return;
    track("signin_started", { provider: "x" });
    const redirectUrl = window.location.origin + "/dashboard";
    window.location.href = `${API}/auth/x/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <div className="px-site px-login" data-testid="login-page">
      <div className="px-login-art" aria-hidden="true">
        <picture>
          <source srcSet="/art/hero.webp" type="image/webp" />
          <img src="/art/hero.png" alt="A pixel corridor of four gates with a lit card travelling between them" decoding="async" />
        </picture>
      </div>
      <span className="px-login-veil" aria-hidden="true" />

      <div className="px-login-inner" ref={entrance}>
        <div className="px-login-head" data-login-enter>
          <span className="px-login-mark" data-testid="login-logo" aria-hidden="true">
            <Glyph seed="AVAIRA" size={40} solid />
          </span>
          <p className="px-label">Execution control protocol</p>
          <h1 className="px-dot px-h2" style={{ marginTop: "0.75rem" }}>
            Sign in to Avaira
          </h1>
        </div>

        <div className="px-login-card" ref={cardTilt}>
          <div className="px-login-card-head">
            <span className="px-label">Session</span>
            <span className="px-mono px-mute">cookie + on-chain mirror</span>
          </div>

          <div className="px-login-card-body" data-testid="login-card" data-login-enter>
            <button
              data-testid="google-login-btn"
              onClick={handleGoogleLogin}
              disabled={backendMisconfigured}
              className="px-btn px-btn-lg"
              style={{ width: "100%" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>

            <button
              data-testid="x-login-btn"
              onClick={handleXLogin}
              disabled={backendMisconfigured}
              className="px-btn px-btn-lg"
              style={{ width: "100%" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Continue with X
            </button>

            {backendMisconfigured && (
              <div className="px-login-note" data-testid="login-backend-missing">
                <Unplug size={13} strokeWidth={2} className="px-accent-text" />
                <p className="px-mono px-mute">
                  No API is attached to this deployment, so sign-in cannot complete. Point
                  REACT_APP_BACKEND_URL at the Avaira backend and redeploy to enable it.
                </p>
              </div>
            )}

            <div className="px-login-note">
              <ShieldCheck size={13} strokeWidth={2} className="px-accent-text" />
              <p className="px-mono px-mute">
                Sessions are cookie-based and mirrored on-chain. By signing in you agree to the Avaira
                Protocol terms.
              </p>
            </div>
          </div>
        </div>

        <button
          data-testid="back-home-btn"
          onClick={() => navigate("/")}
          className="px-btn px-btn-quiet px-login-back"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Back to home
        </button>
      </div>
    </div>
  );
}
