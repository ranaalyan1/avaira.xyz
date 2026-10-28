import { useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@/App";
import { useAuthUI } from "@/components/auth/AuthUIContext";
import { useNavigate } from "react-router-dom";
import "../landing-immersive.css";

/* Shared shell for the immersive narrative pages. The landing was one long
 * scroll; it is now four routes (boundary, execution, evidence, docs) sharing
 * this nav + footer, so each act deep-links, prerenders and titles on its own. */

/* The explorer of the chain the deployed contracts actually live on (see
 * contracts/deployments/46630.json). Pointing the evidence links at the
 * mainnet explorer while the deployment is testnet made every "view" link
 * dead — the exact kind of unverifiable claim this protocol exists to kill.
 * When the mainnet (4663) deploy lands, this moves with it. One line. */
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com/address";

export const DEPLOYMENTS = [
  ["IdentityRegistry", "0xBAd4cb2Ec6667674b2B61B1d4C8FFfbF7FE64040"],
  ["ReputationRegistry", "0xA565859472b507C539Fec560cc03D98a090108aB"],
  ["ValidationRegistry", "0x64DA01075D461Ef772E31fbE85fd74166852C72f"],
  ["StakeRegistry", "0x430fBFc8B5D77c7063725ECDd4c6E56CB952bd99"],
  ["IntentVault", "0x7778b9698cBA4Ff687Aa054c836F27b17640bF1c"],
  ["CreditMarket", "0xa542F94233783EB0Ac55a48695D9bd9224EE025C"],
  ["Settlement token (MockUSDC)", "0x6f92176d07634Be0D2E0334178fa23866aCcE802"],
];

export const LAYERS = [
  {
    no: "L1", key: "identity", name: "Identity",
    body: "An agent is not a vibe. Registration is an ERC-8004 identity with a forfeitable bond, so a name you can slash stands behind every action.",
    reason: "UNKNOWN_AGENT / BANNED",
  },
  {
    no: "L2", key: "stake", name: "Stake",
    body: "Collateral in the game before an action is allowed. Below 100 USDC the gate closes and no amount of eloquence reopens it.",
    reason: "STAKE_TOO_LOW / SUSPENDED",
  },
  {
    no: "L3", key: "score", name: "Score",
    body: "A 0-100 accountability score computed from settled history with a public formula, so any two observers reach the same grade. Below 60, no execution.",
    reason: "SCORE_TOO_LOW",
  },
  {
    no: "L4", key: "intent", name: "Intent",
    body: "The plan is committed before execution: the action hash and its risk envelope (spend cap, allowed actions, deadline) are onchain first.",
    reason: "INTENT_NOT_COMMITTED / INTENT_ALREADY_EXECUTED",
  },
  {
    no: "L5", key: "time", name: "Time and scope",
    body: "A deadline and an exact envelope hash bound what was promised. Late execution, or execution of a different plan, is refused by the byte.",
    reason: "INTENT_EXPIRED / ENVELOPE_MISMATCH",
  },
];

export const SOCIALS = [
  { label: "X (Avaira)", href: "https://x.com/avairaprotocol", note: "@avairaprotocol" },
  { label: "X (founder)", href: "https://x.com/alyan_rana1", note: "@alyan_rana1" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/m-alyan-ashraf", note: "M. Alyan Ashraf" },
  { label: "GitHub", href: "https://github.com/ranaalyan1", note: "ranaaliyan1" },
];

export const REFUSALS = [
  "UNKNOWN_AGENT", "BANNED", "SUSPENDED", "STAKE_TOO_LOW", "SCORE_TOO_LOW",
  "INTENT_NOT_COMMITTED", "INTENT_EXPIRED", "INTENT_ALREADY_EXECUTED", "ENVELOPE_MISMATCH",
];

export const WORKFLOW = [
  { no: "01", name: "Commit", fn: "commitIntent", body: "The agent's plan and risk envelope are committed onchain before anything runs." },
  { no: "02", name: "Gate", fn: "checkGate", body: "One read answers five checks: identity, stake, score, intent, scope. View call, no gas." },
  { no: "03", name: "Execute", fn: "execute_fn", body: "Your code runs. Avaira never executes the action for you and never needs to." },
  { no: "04", name: "Attest", fn: "attestOutcome", body: "The outcome hash and its Merkle root are anchored, opening a 24-hour challenge window." },
  { no: "05", name: "Challenge", fn: "challengeDeviation", body: "Anyone with a proof can challenge a deviation. An upheld proof slashes stake." },
];

/* the page selector — every immersive route lists itself here once */
export const NAV_LINKS = [
  { to: "/", label: "The boundary", end: true },
  { to: "/execution", label: "Execution" },
  { to: "/evidence", label: "Evidence" },
  { to: "/docs", label: "Docs" },
];

/* one place sets the tab title so prerendered pages carry their own <title> */
export { usePageTitle } from "@/lib/pageTitle";

/**
 * Route changes land at the top — except when the link carries a hash, in which
 * case they land on that section.
 *
 * The footer and the nav link to anchors (`/gate#moats`, `/#boundary`, …). The
 * browser cannot honour those on its own because the target element does not
 * exist yet when the route changes, and the previous implementation scrolled to
 * the top unconditionally, so every one of those links silently did nothing.
 */
export const ScrollTop = () => {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const jumpToTop = () => window.scrollTo({ top: 0, behavior: "auto" });

    if (!hash || hash === "#") {
      jumpToTop();
      return undefined;
    }

    /* A malformed hash (`#%`) must not throw inside the route tree. */
    let id = hash.replace(/^#/, "");
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep the raw fragment */
    }
    if (!id) {
      jumpToTop();
      return undefined;
    }

    /* The page paints after the route changes, so wait for the frame (and then
     * one more) before looking the anchor up. Falls back to the top when the
     * target does not exist, instead of leaving the visitor mid-page. */
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        const target = document.getElementById(id);
        if (!target) {
          jumpToTop();
          return;
        }
        const reduced = typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      });
    });

    return () => {
      window.cancelAnimationFrame(outer);
      if (inner) window.cancelAnimationFrame(inner);
    };
  }, [pathname, hash]);
  return null;
};

export function ImmersiveNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  /* Keep the destination when the visitor has to sign in first, so the console
   * opens after auth instead of dropping them on the dashboard default. */
  const go = (path) => () =>
    navigate(user ? path : `/login?redirect=${encodeURIComponent(path)}`);
  const { openAuth, walletAddress } = useAuthUI();
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;

  return (
    <nav className="imm-nav" aria-label="Avaira">
      <Link className="imm-wordmark" to="/" aria-label="Avaira home">
        <img src="/logo.png" alt="Avaira mark" width="34" height="34" />
        AVaira<span>.</span>
      </Link>
      <div className="imm-nav-links">
        {NAV_LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? "imm-nav-on" : undefined)}>
            {l.label}
          </NavLink>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.7rem", alignItems: "center" }}>
        {user ? (
          <button type="button" className="imm-btn imm-btn-primary" data-testid="launch-protocol-btn" onClick={go("/dashboard")}>
            Open console
          </button>
        ) : (
          <>
            {shortWallet ? (
              <button type="button" className="imm-nav-wallet" data-testid="nav-wallet-btn" onClick={openAuth} title="Wallet identity">
                <i aria-hidden="true" /> {shortWallet}
              </button>
            ) : (
              <button type="button" className="imm-btn imm-btn-ghost" data-testid="nav-login-btn" onClick={openAuth}>
                Sign in
              </button>
            )}
            <button type="button" className="imm-btn imm-btn-primary" data-testid="launch-protocol-btn" onClick={go("/dashboard")}>
              Open console
            </button>
          </>
        )}
      </div>
    </nav>
  );
}

/* the refusal ticker — the nine real revert codes, on a slow loop */
export function RefusalTicker() {
  return (
    <div className="imm-ticker" aria-label="The nine refusal codes" role="img">
      <div className="imm-ticker-track">
        {[0, 1].map((dup) => (
          <span key={dup} aria-hidden={dup === 1 ? "true" : undefined}>
            {REFUSALS.map((code) => (
              <span key={code}>{code} <i>{"//"}</i> </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ImmersiveFoot() {
  return (
    <footer className="imm-foot" data-testid="footer-section">
      <div className="imm-foot-grid">
        <div className="imm-foot-brand">
          <Link className="imm-wordmark" to="/" aria-label="Avaira home">
            <img src="/logo.png" alt="Avaira mark" width="34" height="34" />
            AVaira<span>.</span>
          </Link>
          <p className="imm-tagline">
            Onchain accountability for AI agents. Commit the plan, gate the
            action, attest the outcome, slash the deviation.
          </p>
          <div className="imm-founder">
            <div>
              <span>Founded by</span>
              <br />
              <a href="https://x.com/avairaprotocol">Muhammad Alyan Ashraf</a>
            </div>
          </div>
        </div>
        <div className="imm-foot-col">
          <h4>Explore</h4>
          <ul>
            <li><Link to="/">The boundary</Link></li>
            <li><Link to="/execution">Execution</Link></li>
            <li><Link to="/evidence">Evidence</Link></li>
            <li><Link to="/docs">Docs</Link></li>
          </ul>
        </div>
        <div className="imm-foot-col">
          <h4>Protocol</h4>
          <ul>
            <li><Link to="/gate">Gate mechanics</Link></li>
            <li><Link to="/score">The score</Link></li>
            <li><Link to="/ledger">Evidence ledger</Link></li>
            <li><Link to="/docs">Docs and SDK</Link></li>
          </ul>
        </div>
        <div className="imm-foot-col">
          <h4>Connect</h4>
          <ul>
            {SOCIALS.map((s2) => (
              <li key={s2.href}>
                <a href={s2.href}>{s2.label}<span>{s2.note}</span></a>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="imm-foot-bottom">
        <p>{`(c) 2026 Avaira — an independent project, not affiliated with Robinhood`}</p>
        <p>{`Testnet deployment live / chain 46630 / mainnet 4663 staged`}</p>
      </div>
    </footer>
  );
}
