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
} from "@dynamic-labs-sdk/react-hooks";
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

  const { mutate: sendEmailOTP, data: otpVerification, isPending: sending, error: sendError } = useSendEmailOTP();
  const { mutate: verifyOTP, isPending: verifying, error: verifyError } = useVerifyOTP();
  const { mutate: logout } = useLogout();
  const { data: user } = useUser();
  const { data: accounts = [] } = useGetWalletAccounts();

  const codeRef = useRef(null);
  useEffect(() => {
    if (otpVerification && codeRef.current) codeRef.current.focus();
  }, [otpVerification]);

  const rawError = verifyError || sendError;
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
          <a
            className="imm-btn imm-btn-primary"
            href="/gate"
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

  /* step 1: email */
  if (!otpVerification) {
    return (
      <div className="imm-auth-body">
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
          <button className="imm-btn imm-btn-primary" type="submit" disabled={sending || !email.trim()}>
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
