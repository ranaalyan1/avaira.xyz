import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/App";
import { useReveal } from "@/lib/motion";
import { useAuthUI } from "@/components/auth/AuthUIContext";
import { ImmersiveNav, ImmersiveFoot, usePageTitle } from "@/pages/immersive/shell";
import { safeInternalPath } from "@/lib/navigation";

/* Sign-in, in the immersive language. The heavy Dynamic SDK stays at the app
 * root; this page only opens the shared sign-in modal (and auto-opens it once
 * for a visitor who landed here on purpose). The old backend-OAuth buttons are
 * gone: there is no session backend on this deployment, so they could only
 * redirect into the SPA's own 404. */

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /* validated: the target cannot leave the origin (from #51) */
  const redirect = safeInternalPath(params.get("redirect"));
  const { user } = useAuth();
  const { openAuth, walletAddress, authConfigured } = useAuthUI();
  const revealRoot = useReveal();
  const opened = useRef(false);
  usePageTitle("Sign in — AVAIRA");

  /* a visitor who chose /login gets the modal without an extra click */
  useEffect(() => {
    if (opened.current || !authConfigured || walletAddress) return;
    opened.current = true;
    const t = setTimeout(openAuth, 650);
    return () => clearTimeout(t);
  }, [authConfigured, walletAddress, openAuth]);

  /* signed in through the modal → straight to where they were going */
  useEffect(() => {
    if (walletAddress) navigate(redirect, { replace: true });
  }, [walletAddress, navigate, redirect]);

  const signedIn = Boolean(user || walletAddress);

  return (
    <div className="landing-immersive" data-testid="login-page" ref={revealRoot}>
      <ImmersiveNav />

      <main className="imm-login">
        <div className="imm-login-copy">
          <p className="imm-label">Session <em>— identity</em></p>
          <h1 data-testid="login-logo">
            Sign in to the gate<span style={{ color: "var(--imm-lime)" }}>.</span>
          </h1>
          <p className="imm-body">
            One identity opens the console: an email, a wallet, or a social
            login. Every session mints an embedded wallet that holds the
            ERC-8004 identity your agents act under — the bond, the score and
            the permits all hang off it.
          </p>
          <ul className="imm-meta">
            <li>Dynamic</li>
            <li>embedded wallet</li>
            <li>chain 4663</li>
          </ul>
        </div>

        <div className="imm-login-card" data-testid="login-card">
          <p className="imm-label">{signedIn ? "Signed in" : "Sign in"}</p>
          <h2>{signedIn ? "Identity active" : "Email or social, one tap"}</h2>

          {signedIn ? (
            <div className="imm-login-row">
              <p className="imm-body" style={{ margin: 0 }}>
                {walletAddress
                  ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
                  : "session active"}
              </p>
              <button
                type="button"
                className="imm-btn imm-btn-primary"
                onClick={() => navigate(redirect)}
              >
                Open the console
              </button>
            </div>
          ) : (
            <div className="imm-login-row">
              <button
                type="button"
                className="imm-btn imm-btn-primary"
                data-testid="login-signin-btn"
                onClick={openAuth}
              >
                Continue with email or social
              </button>
              {!authConfigured && (
                <p className="imm-login-note" data-testid="login-auth-missing">
                  <i>//</i>
                  <span>
                    REACT_APP_DYNAMIC_ENV_ID is not set on this deployment, so
                    sign-in cannot complete. Point it at your Dynamic environment
                    and redeploy to enable it.
                  </span>
                </p>
              )}
              <p className="imm-login-note">
                <i>//</i>
                <span>
                  Sessions are handled by Dynamic; an embedded wallet is created
                  per identity. By signing in you agree to the Avaira Protocol
                  terms.
                </span>
              </p>
            </div>
          )}

          <Link className="imm-login-back" data-testid="back-home-btn" to="/">
            ← Back to the boundary
          </Link>
        </div>
      </main>

      <ImmersiveFoot />
    </div>
  );
}
