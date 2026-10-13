import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { API } from "@/lib/api";
import { animate, stagger, useEnterAnimation, usePointerTilt } from "@/lib/motion";

export default function Login() {
  const navigate = useNavigate();
  const cardTilt = usePointerTilt({ max: 4.5 });
  const entrance = useEnterAnimation((_scope, root) => {
    animate(root.querySelectorAll("[data-login-enter]"), {
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 620,
      delay: stagger(90),
      ease: "out(3)",
    });
  });

  const handleGoogleLogin = () => {
    const redirectUrl = window.location.origin + '/dashboard';
    window.location.href = `${API}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const handleXLogin = () => {
    const redirectUrl = window.location.origin + '/dashboard';
    window.location.href = `${API}/auth/x/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <div
      className="theme-marketing relative flex min-h-screen items-center justify-center overflow-hidden bg-avaira-bg px-4 py-12 sm:px-6"
      data-testid="login-page"
    >
      <div className="mk-grid-bg absolute inset-0 -z-20" />
      <div className="mk-glow -z-10 h-[380px] w-[480px] left-1/2 top-[-140px] -translate-x-1/2 mk-glow-violet" />
      <div className="mk-glow -z-10 h-[280px] w-[340px] right-[8%] bottom-[-80px] mk-glow-sky opacity-40" />

      <div className="w-full max-w-[420px]" ref={entrance}>
        <div className="mb-7 text-center" data-login-enter>
          <img
            src="/logo.png"
            alt="AVAIRA"
            className="mx-auto mb-4 h-16 w-16 rounded-2xl"
            data-testid="login-logo"
          />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Sign in to AVAIRA</h1>
          <p className="mt-1.5 text-[13px] text-avaira-muted">
            Execution control protocol for autonomous agents
          </p>
        </div>

        <div className="login-card-3d" ref={cardTilt}>
          <div className="mk-card p-6" data-testid="login-card" data-login-enter>
          <button
            data-testid="google-login-btn"
            onClick={handleGoogleLogin}
            className="mk-btn mk-btn-secondary mb-3 w-full"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          <button
            data-testid="x-login-btn"
            onClick={handleXLogin}
            className="mk-btn mk-btn-secondary w-full"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
            Continue with X
          </button>

            <div className="mt-5 flex items-center gap-2 border-t border-avaira-border pt-4">
              <ShieldCheck size={13} className="flex-none text-avaira-primary" />
              <p className="text-[12px] leading-relaxed text-avaira-muted">
                Sessions are cookie-based and mirrored on-chain. By signing in you agree to the AVAIRA
                Protocol terms.
              </p>
            </div>
          </div>
        </div>

        <button
          data-testid="back-home-btn"
          onClick={() => navigate('/')}
          className="mx-auto mt-5 flex items-center gap-1.5 text-[13px] font-medium text-avaira-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to home
        </button>
      </div>
    </div>
  );
}
