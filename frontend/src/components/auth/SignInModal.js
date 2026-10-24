/**
 * The Avaira sign-in modal — headless Dynamic email-OTP flow in the
 * site's black + #CCFF00 language.
 *
 * Two states:
 *   1. not configured (no REACT_APP_DYNAMIC_ENV_ID): explains what is
 *      missing instead of pretending to work.
 *   2. configured: email → send code → verify code. After verify, the
 *      wallet is created by WaasBootstrap and the modal shows the
 *      signed-in readout with the wallet address and a sign-out action.
 */
import { useEffect, useRef, useState } from "react";
import {
  useSendEmailOTP,
  useVerifyOTP,
  useLogout,
  useUser,
  useGetWalletAccounts,
  useSignInWithSocialPopUp,
} from "@dynamic-labs-sdk/react-hooks";

/* Social providers shown in the modal. Each must also be toggled on in
   the Dynamic dashboard under Sign-in Methods. */
const PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
  { id: "discord", label: "Discord" },
  { id: "github", label: "GitHub" },
  { id: "twitter", label: "X" },
];

function ProviderIcon({ id }) {
  const common = { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "currentColor" };
  switch (id) {
    case "google": return (
      <svg {...common} aria-hidden="true"><path d="M21.35 11.1h-9.17v2.73h6.45c-.27 1.87-2.24 5.47-7.4 5.47A7.3 7.3 0 0 1 3.9 12 7.3 7.3 0 0 1 11.23 4.7c2.53 0 4.24 1.08 5.22 2l1.93-1.86A9.5 9.5 0 0 0 11.23 2a10 10 0 1 0 0 20c5.78 0 9.6-4.06 9.6-9.77 0-.4-.04-.7-.1-1.13z"/></svg>
    );
    case "apple": return (
      <svg {...common} aria-hidden="true"><path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.34-1.96-3.43-2.23-4.18-2.26-1.78-.18-3.47 1.04-4.38 1.04-.9 0-2.3-1.02-3.78-1-1.94.03-3.73 1.13-4.73 2.86-2.02 3.51-.52 8.71 1.45 11.55.96 1.39 2.1 2.94 3.6 2.88 1.44-.06 1.99-.93 3.73-.93s2.23.93 3.75.9c1.55-.03 2.53-1.41 3.48-2.8 1.1-1.6 1.55-3.15 1.57-3.23-.03-.02-3.02-1.16-3.05-4.6zM14.15 3.87c.79-.96 1.33-2.3 1.18-3.63-1.14.05-2.53.76-3.35 1.72-.73.85-1.38 2.2-1.21 3.5 1.28.1 2.58-.64 3.38-1.59z"/></svg>
    );
    case "discord": return (
      <svg {...common} aria-hidden="true"><path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.48 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.1c-.65-.25-1.27-.55-1.86-.9a.08.08 0 0 1 0-.12l.37-.29a.07.07 0 0 1 .08-.01 14.2 14.2 0 0 0 12.06 0 .07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13c-.6.34-1.22.63-1.86.9a.08.08 0 0 0-.05.1c.36.69.77 1.35 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42z"/></svg>
    );
    case "github": return (
      <svg {...common} aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7 0-.7 0-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.8.1 3.2.9.8 1.4 1.9 1.4 3.1 0 4.7-2.9 5.7-5.6 6 .5.4.9 1.2.9 2.4v3.5c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/></svg>
    );
    default: return (
      <svg {...common} aria-hidden="true"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z"/></svg>
    );
  }
}
import { dynamicAuthConfigured } from "@/dynamicClient";
import "./auth.css";
import { useAuthUI } from "./AuthUIContext";

function shortAddr(a) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/* ── the live flow (only mounted when configured) ───────────────── */

function OtpFlow() {
  const { closeAuth } = useAuthUI();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [flowError, setFlowError] = useState(null);

  const { mutate: socialSignIn, isPending: socialPending, error: socialError } = useSignInWithSocialPopUp();
  const [pendingProvider, setPendingProvider] = useState(null);
  const { mutate: sendEmailOTP, data: otpVerification, isPending: sending, error: sendError } = useSendEmailOTP();
  const { mutate: verifyOTP, isPending: verifying, error: verifyError } = useVerifyOTP();
  const { mutate: logout } = useLogout();
  const { data: user } = useUser();
  const { data: accounts = [] } = useGetWalletAccounts();

  const codeRef = useRef(null);
  useEffect(() => {
    if (otpVerification && codeRef.current) codeRef.current.focus();
  }, [otpVerification]);

  const rawError = verifyError || sendError || socialError;
  useEffect(() => {
    if (rawError) setFlowError(String(rawError?.message || rawError).slice(0, 140));
  }, [rawError]);

  /* signed in — show the readout */
  if (user) {
    const addr = accounts[0]?.address;
    return (
      <div className="imm-auth-body" data-testid="auth-signed-in">
        <p className="imm-auth-label">Signed in as</p>
        <p className="imm-auth-addr">{user.email || "dynamic user"}</p>
        <p className="imm-auth-label" style={{ marginTop: "1.1rem" }}>Embedded wallet</p>
        <p className="imm-auth-addr imm-auth-addr-lime">{addr ? shortAddr(addr) : "creating…"}</p>
        <p className="imm-auth-note">
          This wallet is your Avaira identity surface. Register an agent, post
          stake, and the gate reads it onchain.
        </p>
        <div className="imm-auth-actions">
          {/* The console lives at /dashboard; /gate is the public explainer. */}
          <a
            className="imm-btn imm-btn-primary"
            href="/dashboard"
            data-testid="auth-open-console"
            onClick={closeAuth}
          >
            Open the console
          </a>
          <button type="button" className="imm-btn imm-btn-ghost" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  /* step 1: social + email */
  if (!otpVerification) {
    return (
      <div className="imm-auth-body">
        <div className="imm-auth-social" data-testid="auth-social-row">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="imm-auth-sbtn"
              data-testid={`auth-social-${p.id}`}
              title={`Continue with ${p.label}`}
              disabled={socialPending}
              onClick={() => { setPendingProvider(p.id); socialSignIn({ provider: p.id }); }}
            >
              <ProviderIcon id={p.id} />
              <span>{pendingProvider === p.id && socialPending ? "Opening…" : p.label}</span>
            </button>
          ))}
        </div>
        <div className="imm-auth-divider"><span>or with email</span></div>
        <p className="imm-auth-note">
          One email, one code, one embedded wallet. No extension, no seed
          phrase — the wallet is created for you and bound to your account.
        </p>
        <form
          className="imm-auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) sendEmailOTP({ email: email.trim() });
          }}
        >
          <label className="imm-auth-label" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className="imm-auth-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@protocol.xyz"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="imm-btn imm-btn-primary" type="submit" data-testid="auth-send-code" disabled={sending || !email.trim()}>
            {sending ? "Sending code…" : "Send code"}
          </button>
        </form>
        {flowError && <p className="imm-auth-error" role="alert">{flowError}</p>}
      </div>
    );
  }

  /* step 2: code */
  return (
    <div className="imm-auth-body">
      <p className="imm-auth-note">
        Code sent to <b>{email}</b>. Six digits, then you are in.
      </p>
      <form
        className="imm-auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) verifyOTP({ otpVerification, verificationToken: code.trim() });
        }}
      >
        <label className="imm-auth-label" htmlFor="auth-code">Verification code</label>
        <input
          id="auth-code"
          ref={codeRef}
          className="imm-auth-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
        <button className="imm-btn imm-btn-primary" type="submit" disabled={verifying || code.length < 6}>
          {verifying ? "Verifying…" : "Verify"}
        </button>
      </form>
      {flowError && <p className="imm-auth-error" role="alert">{flowError}</p>}
    </div>
  );
}

/* ── the modal shell ────────────────────────────────────────────── */

export default function SignInModal() {
  const { authOpen, closeAuth } = useAuthUI();

  useEffect(() => {
    if (!authOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeAuth(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [authOpen, closeAuth]);

  if (!authOpen) return null;

  return (
    <div
      className="imm-auth-backdrop"
      data-testid="auth-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Avaira"
      onClick={(e) => { if (e.target === e.currentTarget) closeAuth(); }}
    >
      <div className="imm-auth-card">
        <div className="imm-auth-head">
          <p className="imm-auth-kicker">AVaira — identity, stake, score</p>
          <h3 className="imm-auth-title">Sign in<span>.</span></h3>
          <button type="button" className="imm-auth-x" aria-label="Close" onClick={closeAuth}>✕</button>
        </div>

        {dynamicAuthConfigured ? (
          <OtpFlow />
        ) : (
          <div className="imm-auth-body" data-testid="auth-unconfigured">
            <p className="imm-auth-note">
              Wallet sign-in is wired and ready, but this deployment has no
              Dynamic environment configured yet.
            </p>
            <p className="imm-auth-note">
              Set <code className="imm-auth-code">REACT_APP_DYNAMIC_ENV_ID</code> with an
              environment ID from the Dynamic console and the email + embedded
              wallet flow goes live. The console pages keep their existing
              sign-in until then.
            </p>
            <div className="imm-auth-actions">
              <a
                className="imm-btn imm-btn-ghost"
                href="https://console.dynamic.xyz/dashboard/developer/api"
                target="_blank"
                rel="noreferrer"
              >
                Dynamic console
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
