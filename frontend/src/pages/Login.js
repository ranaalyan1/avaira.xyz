import { useNavigate } from "react-router-dom";
import { Wallet, ShieldCheck } from "lucide-react";
import { API } from "@/lib/api";
import { isDynamicConfigured } from "@/lib/dynamicConfig";
import DynamicOperatorButton from "@/components/DynamicOperatorButton";

export default function Login() {
  const navigate = useNavigate();

  const handleGoogleLogin = () => {
    const redirectUrl = window.location.origin + '/dashboard';
    window.location.href = `${API}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const handleXLogin = () => {
    const redirectUrl = window.location.origin + '/dashboard';
    window.location.href = `${API}/auth/x/login?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <div className="min-h-screen bg-avaira-bg flex items-start sm:items-center justify-center px-4 sm:px-6 py-10 sm:py-14 animate-slide-in" data-testid="login-page">
      {/* Grid bg */}
      <div className="fixed inset-0 -z-10" style={{ backgroundImage: 'linear-gradient(rgba(232,68,68,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(232,68,68,0.02) 1px, transparent 1px)', backgroundSize: '60px 60px' }} />

      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-7 sm:mb-8">
          <img src="/logo.png" alt="AVAIRA" className="w-24 h-24 sm:w-28 sm:h-28 mx-auto mb-4" data-testid="login-logo" />
          <h1 className="font-heading font-bold text-3xl sm:text-4xl text-foreground uppercase tracking-tight">AVAIRA</h1>
          <p className="font-mono text-[10px] text-avaira-muted tracking-[0.3em] mt-1">EXECUTION CONTROL PROTOCOL</p>
        </div>

        {/* Login Card */}
        <div className="cyber-card corner-cut p-5 sm:p-6" data-testid="login-card">
          <p className="font-heading font-semibold text-sm text-foreground uppercase tracking-wider text-center mb-6">
            Sign in to access the protocol
          </p>

          {/* Google Button */}
          <button
            data-testid="google-login-btn"
            onClick={handleGoogleLogin}
            className="w-full flex items-center justify-center gap-3 p-3 bg-white text-black font-heading font-semibold text-sm uppercase tracking-wider hover:bg-gray-100 transition-colors mb-3"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* X Button */}
          <button
            data-testid="x-login-btn"
            onClick={handleXLogin}
            className="w-full flex items-center justify-center gap-3 p-3 bg-black border border-avaira-border text-foreground font-heading font-semibold text-sm uppercase tracking-wider hover:border-avaira-primary transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
            Continue with X
          </button>

          {/* Dynamic embedded wallet — operator / underwriter sign-in (Workstream 2) */}
          {isDynamicConfigured ? (
            <div className="mt-3">
              <DynamicOperatorButton onSignedIn={() => navigate("/dashboard")} />
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-center gap-2 p-3 border border-dashed border-avaira-border font-mono text-[10px] text-avaira-dim">
              <Wallet size={12} /> Dynamic embedded wallets disabled (REACT_APP_DYNAMIC_ENV_ID unset)
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-avaira-border text-center">
            <p className="font-mono text-[9px] text-avaira-dim">
              <ShieldCheck size={10} className="inline mr-1" />
              By signing in, you agree to the AVAIRA Protocol terms. Embedded wallets are
              non-custodial and sign locally in your browser.
            </p>
          </div>
        </div>

        {/* Back link */}
        <button
          data-testid="back-home-btn"
          onClick={() => navigate('/')}
          className="block mx-auto mt-4 font-mono text-[10px] text-avaira-dim hover:text-avaira-muted transition-colors uppercase tracking-wider"
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}
